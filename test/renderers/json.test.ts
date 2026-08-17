import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { sanitizeCheckResult } from "../../src/checks/sanitize-result.js";
import { validateReportableSnapshotPath } from "../../src/git/snapshot-path.js";
import { renderJson } from "../../src/renderers/json.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

describe("renderJson", () => {
  it("serializes the versioned contract deterministically without terminal decoration", () => {
    const finding = createFinding({
      attribution: {
        kind: "range-overlap",
        staged: true,
        evidence: ["z-evidence", "a-evidence"],
      },
    });
    const report = createReport({
      outcome: "blocked",
      exitCode: 1,
      summary: {
        passed: 0,
        warnings: 0,
        failed: 1,
        incomplete: 0,
        findings: [finding],
      },
      checks: [
        {
          checkId: "formatting",
          target: "apps/web",
          status: "completed",
          durationMs: 4,
          findings: [finding],
        },
      ],
    });

    const first = renderJson(report);
    const second = renderJson(report);
    const parsed = JSON.parse(first) as Record<string, unknown>;

    expect(first).toBe(second);
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "outcome",
      "exitCode",
      "repositoryRoot",
      "baseline",
      "target",
      "stagedFileCount",
      "startedAt",
      "durationMs",
      "networkDisclosures",
      "summary",
      "checks",
    ]);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      outcome: "blocked",
      exitCode: 1,
      repositoryRoot: ".",
      baseline: "HEAD",
      target: "index",
      stagedFileCount: 1,
      startedAt: "2026-08-15T00:00:00.000Z",
      durationMs: 15,
      networkDisclosures: [],
      summary: { passed: 0, warnings: 0, failed: 1, incomplete: 0 },
    });
    expect(first).not.toContain("\u001b");
    expect(first).not.toContain("BEE-UTIFUL");
    expect(first).not.toContain("/repo");
    expect(
      (
        parsed.checks as {
          target?: string;
          findings: { attribution: { evidence: string[] } }[];
        }[]
      )[0],
    ).toMatchObject({
      target: "apps/web",
      findings: [{ attribution: { evidence: ["a-evidence", "z-evidence"] } }],
    });
    expect(first.endsWith("\n")).toBe(true);
  });

  it("serializes optional diagnostics and omits secret excerpt text", () => {
    const sourceFinding = createFinding({
      sourceExcerpt: {
        line: 2,
        text: "export const value = 1;",
        redacted: false,
        truncated: false,
      },
    });
    const secretFinding = createFinding({
      id: "secret-1",
      check: "secrets",
      rule: "generic-api-key",
      sourceExcerpt: {
        line: 2,
        redacted: true,
        truncated: false,
      },
    });
    const report = createReport({
      checks: [
        {
          checkId: "formatting",
          status: "incomplete",
          durationMs: 4,
          findings: [sourceFinding, secretFinding],
          error: {
            code: "PRETTIER_FAILED",
            message: "Prettier could not analyze the staged file.",
            path: "src/value.ts",
            remediation: "Fix the parser error and stage the result.",
          },
        },
      ],
    });

    const parsed = JSON.parse(renderJson(report)) as {
      checks: Array<{
        error: Record<string, unknown>;
        findings: Array<Record<string, unknown>>;
      }>;
    };

    expect(parsed.checks[0]?.error).toEqual({
      code: "PRETTIER_FAILED",
      message: "Prettier could not analyze the staged file.",
      path: "src/value.ts",
      remediation: "Fix the parser error and stage the result.",
    });
    expect(parsed.checks[0]?.findings).toEqual([
      expect.objectContaining({
        id: "finding-1",
        sourceExcerpt: {
          line: 2,
          text: "export const value = 1;",
          redacted: false,
          truncated: false,
        },
      }),
      expect.objectContaining({
        id: "secret-1",
        sourceExcerpt: {
          line: 2,
          redacted: true,
          truncated: false,
        },
      }),
    ]);
    expect(
      Object.hasOwn(
        parsed.checks[0]?.findings[1]?.sourceExcerpt as object,
        "text",
      ),
    ).toBe(false);
    expect(JSON.stringify(parsed.checks[0]?.findings[1])).not.toContain(
      '"text"',
    );
    expect(Object.hasOwn(parsed.checks[0]!, "skipReason")).toBe(false);
    expect(Object.hasOwn(parsed.checks[0]?.findings[1]!, "remediation")).toBe(
      true,
    );
  });

  it("omits every absent optional field and retains incomplete summary data", () => {
    const {
      location: _location,
      remediation: _remediation,
      sourceExcerpt: _sourceExcerpt,
      ...finding
    } = createFinding();
    const report = createReport({
      outcome: "incomplete",
      exitCode: 2,
      summary: {
        passed: 0,
        warnings: 0,
        failed: 1,
        incomplete: 1,
        findings: [finding],
      },
      checks: [
        {
          checkId: "formatting",
          status: "incomplete",
          durationMs: 4,
          findings: [finding],
          error: {
            code: "PRETTIER_FAILED",
            message: "Prettier could not analyze the staged file.",
          },
        },
      ],
    });

    const parsed = JSON.parse(renderJson(report)) as {
      summary: Record<string, unknown>;
      checks: Array<{
        skipReason?: string;
        error: Record<string, unknown>;
        findings: Array<Record<string, unknown>>;
      }>;
    };
    const serializedFinding = parsed.checks[0]!.findings[0]!;

    expect(parsed.summary.incomplete).toBe(1);
    expect(Object.hasOwn(parsed.checks[0]!, "skipReason")).toBe(false);
    expect(Object.keys(parsed.checks[0]!.error)).toEqual(["code", "message"]);
    expect(Object.hasOwn(serializedFinding, "location")).toBe(false);
    expect(Object.hasOwn(serializedFinding, "remediation")).toBe(false);
    expect(Object.hasOwn(serializedFinding, "sourceExcerpt")).toBe(false);
  });

  it("rejects unsafe raw diagnostic control text", () => {
    const report = createReport({
      checks: [
        {
          checkId: "formatting",
          status: "incomplete",
          durationMs: 4,
          findings: [],
          error: {
            code: "PRETTIER_FAILED",
            message: "unsafe\u001b[2Jdiagnostic",
          },
        },
      ],
    });

    expect(() => renderJson(report)).toThrow(/display text/i);
  });

  it("serializes the sanitized copies of raw report fields", () => {
    const finding = createFinding({
      sourceExcerpt: {
        line: 2,
        text: "  const BIDI_MARKER = 'before\u202eafter';\u001b[31m",
        redacted: false,
        truncated: false,
      },
    });
    const report = createReport({
      checks: [
        {
          checkId: "formatting",
          status: "incomplete",
          durationMs: 4,
          findings: [finding],
          error: {
            code: "PRETTIER_FAILED",
            message: "Prettier could not analyze the staged file.",
            path: "src\\value.ts",
          },
        },
      ],
    });

    const parsed = JSON.parse(renderJson(report)) as {
      checks: Array<{
        error: { path: string };
        findings: Array<{ sourceExcerpt: { text: string } }>;
      }>;
    };

    expect(parsed.checks[0]?.error.path).toBe("src/value.ts");
    expect(parsed.checks[0]?.findings[0]?.sourceExcerpt.text).toBe(
      "  const BIDI_MARKER = 'before�after';�[31m",
    );
    expect(renderJson(report)).not.toContain("\u202e");
  });

  it("serializes only a validated Zedbee-owned temporary path", async () => {
    const created = await mkdtemp(join(tmpdir(), "zedbee-snapshot-json-"));
    const snapshotRoot = await realpath(created);
    onTestFinished(() => rm(snapshotRoot, { recursive: true }));
    const check = sanitizeCheckResult(
      {
        checkId: "snapshot-cleanup",
        status: "incomplete",
        durationMs: 0,
        findings: [],
        error: {
          code: "SNAPSHOT_CLEANUP_FAILED",
          message: "Zedbee could not remove its temporary snapshot.",
          remediation: "Remove the temporary directory manually.",
        },
      },
      {
        temporaryPath: validateReportableSnapshotPath(snapshotRoot),
      },
    );

    const parsed = JSON.parse(
      renderJson(createReport({ checks: [check] })),
    ) as {
      checks: Array<{ error: Record<string, unknown> }>;
    };

    expect(parsed.checks[0]?.error).toEqual({
      code: "SNAPSHOT_CLEANUP_FAILED",
      message: "Zedbee could not remove its temporary snapshot.",
      temporaryPath: snapshotRoot,
      remediation: "Remove the temporary directory manually.",
    });
  });
});
