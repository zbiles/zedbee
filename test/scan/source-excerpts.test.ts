import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  CheckResult,
  Finding,
  SourceLocation,
} from "../../src/core/types.js";
import { createReport } from "../helpers/scan-report.js";

const readBoundary = vi.hoisted(() => ({
  containedFileReads: [] as string[],
  forbidWholeFileReads: false,
}));

vi.mock("../../src/inspection/read-json.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/inspection/read-json.js")>();
  return {
    ...original,
    async readContainedFile(
      ...args: Parameters<typeof original.readContainedFile>
    ) {
      readBoundary.containedFileReads.push(args[1]);
      if (readBoundary.forbidWholeFileReads) {
        throw new Error("whole-file source excerpt reads are forbidden");
      }
      return original.readContainedFile(...args);
    },
  };
});

import { shouldIncludeSourceExcerpts } from "../../src/scan/reporting-options.js";
import {
  enrichSourceExcerpts,
  omitReportSourceExcerpts,
} from "../../src/scan/source-excerpts.js";

function finding(
  overrides: Omit<Partial<Finding>, "location"> & {
    location?: SourceLocation | undefined;
  } = {},
): Finding {
  const base: Finding = {
    id: "lint:src/value.ts:4",
    check: "lint",
    rule: "no-debugger",
    severity: "error",
    message: "Remove debugger.",
    location: { file: "src/value.ts", startLine: 4 },
    attribution: {
      kind: "range-overlap",
      staged: true,
      evidence: ["src/value.ts:4"],
    },
  };
  const merged = { ...base, ...overrides };
  if (
    Object.prototype.hasOwnProperty.call(overrides, "location") &&
    overrides.location === undefined
  ) {
    const { location: _location, ...withoutLocation } = merged;
    return withoutLocation as Finding;
  }
  return merged as Finding;
}

function completed(findings: readonly Finding[]): CheckResult {
  return {
    checkId: "lint",
    status: "completed",
    durationMs: 1,
    findings,
  };
}

async function sourceSnapshot(contents: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "zedbee-excerpts-"));
  const snapshotRoot = await realpath(created);
  onTestFinished(() => rm(snapshotRoot, { recursive: true }));
  await mkdir(join(snapshotRoot, "src"));
  await writeFile(join(snapshotRoot, "src/value.ts"), contents);
  return snapshotRoot;
}

describe("shouldIncludeSourceExcerpts", () => {
  it.each([
    ["never", "ink", undefined, false],
    ["interactive", "ink", undefined, true],
    ["interactive", "text", undefined, false],
    ["interactive", "json", undefined, false],
    ["always", "text", undefined, true],
    ["never", "json", "include", true],
    ["always", "ink", "exclude", false],
  ] as const)("resolves %s/%s/%s", (policy, surface, override, expected) => {
    expect(shouldIncludeSourceExcerpts(policy, surface, override)).toBe(
      expected,
    );
  });

  it.each([undefined, "include", "exclude"] as const)(
    "omits excerpts for library calls without a reporting surface (%s)",
    (override) => {
      expect(shouldIncludeSourceExcerpts("always", undefined, override)).toBe(
        false,
      );
    },
  );
});

describe("omitReportSourceExcerpts", () => {
  it("immutably removes ordinary source while preserving redaction markers and report metadata", () => {
    const ordinary = finding({
      sourceExcerpt: {
        line: 4,
        text: "export const visible = true;",
        redacted: false,
        truncated: false,
      },
    });
    const secret = finding({
      id: "secret:src/value.ts:8",
      check: "secrets",
      rule: "generic-api-key",
      message: "A secret was detected.",
      location: { file: "src/value.ts", startLine: 8 },
      sourceExcerpt: {
        line: 8,
        text: "SECRET-MUST-NOT-SURVIVE",
        redacted: true,
        truncated: false,
      },
    });
    const report = createReport({
      outcome: "incomplete",
      exitCode: 2,
      networkDisclosures: [
        {
          checkId: "vulnerabilities",
          target: ".",
          services: ["api.osv.dev"],
          metadata: ["exact versions"],
        },
      ],
      presentationPolicy: {
        terminalFindingLimit: "all",
        temporaryReportRetention: 9,
        persistSourceExcerpts: true,
      },
      checks: [
        {
          checkId: "lint",
          target: "workspace",
          status: "incomplete",
          durationMs: 7,
          findings: [ordinary, secret],
          error: {
            code: "LINT_FAILED",
            message: "Lint could not complete.",
            remediation: "Run lint directly.",
          },
          incompleteDisposition: "warn",
        },
      ],
      summary: {
        passed: 0,
        warnings: 0,
        failed: 2,
        incomplete: 1,
        findings: [{ ...ordinary }, { ...secret }],
      },
    });
    const inputJson = JSON.stringify(report);
    const omitted = omitReportSourceExcerpts(report);

    expect(
      omitted.checks[0]?.findings.map(({ sourceExcerpt }) => sourceExcerpt),
    ).toEqual([
      undefined,
      { line: 8, redacted: true, truncated: false },
    ]);
    expect(
      omitted.summary.findings.map(({ sourceExcerpt }) => sourceExcerpt),
    ).toEqual([
      undefined,
      { line: 8, redacted: true, truncated: false },
    ]);
    expect(omitted.summary.findings[0]).toBe(
      omitted.checks[0]?.findings[0],
    );
    expect(omitted.summary.findings[1]).toBe(
      omitted.checks[0]?.findings[1],
    );

    const withoutSource = ({
      sourceExcerpt: _sourceExcerpt,
      ...rest
    }: Finding): Omit<Finding, "sourceExcerpt"> => rest;
    expect(omitted.checks[0]).toMatchObject({
      checkId: "lint",
      target: "workspace",
      status: "incomplete",
      durationMs: 7,
      error: {
        code: "LINT_FAILED",
        message: "Lint could not complete.",
        remediation: "Run lint directly.",
      },
      incompleteDisposition: "warn",
    });
    expect(omitted.checks[0]?.findings.map(withoutSource)).toEqual(
      report.checks[0]?.findings.map(withoutSource),
    );
    expect({
      schemaVersion: omitted.schemaVersion,
      outcome: omitted.outcome,
      exitCode: omitted.exitCode,
      repositoryRoot: omitted.repositoryRoot,
      baseline: omitted.baseline,
      target: omitted.target,
      stagedFileCount: omitted.stagedFileCount,
      startedAt: omitted.startedAt,
      durationMs: omitted.durationMs,
      networkDisclosures: omitted.networkDisclosures,
      presentationPolicy: omitted.presentationPolicy,
    }).toEqual({
      schemaVersion: 1,
      outcome: "incomplete",
      exitCode: 2,
      repositoryRoot: "/repo",
      baseline: "HEAD",
      target: "index",
      stagedFileCount: 1,
      startedAt: "2026-08-15T00:00:00.000Z",
      durationMs: 15,
      networkDisclosures: [
        {
          checkId: "vulnerabilities",
          target: ".",
          services: ["api.osv.dev"],
          metadata: ["exact versions"],
        },
      ],
      presentationPolicy: {
        terminalFindingLimit: "all",
        temporaryReportRetention: 9,
        persistSourceExcerpts: true,
      },
    });
    expect(JSON.stringify(report)).toBe(inputJson);
    expect(Object.isFrozen(report.presentationPolicy)).toBe(false);
    expect(Object.isFrozen(report.checks[0]?.findings[0])).toBe(false);
    expect(omitted).not.toBe(report);
    expect(Object.isFrozen(omitted)).toBe(true);
    expect(Object.isFrozen(omitted.presentationPolicy)).toBe(true);
    expect(Object.isFrozen(omitted.networkDisclosures[0]?.services)).toBe(true);
    expect(Object.isFrozen(omitted.checks[0]?.error)).toBe(true);
    expect(Object.isFrozen(omitted.summary.findings)).toBe(true);
  });
});

describe("enrichSourceExcerpts", () => {
  it("normalizes tabs and terminal controls on the selected source line", async () => {
    const snapshotRoot = await sourceSnapshot(
      "one\ntwo\nthree\n\tconst BIDI_MARKER = 'before\u202eafter';\u001b\u0085\n",
    );

    const [result] = await enrichSourceExcerpts([completed([finding()])], {
      snapshotRoot,
    });

    expect(result?.findings[0]?.sourceExcerpt).toEqual({
      line: 4,
      text: "  const BIDI_MARKER = 'before�after';��",
      redacted: false,
      truncated: false,
    });
  });

  it("splits every JavaScript source line ending", async () => {
    const snapshotRoot = await sourceSnapshot(
      "one\r\ntwo\rthree\nfour\u2028five\u2029six",
    );
    const findings = [1, 2, 3, 4, 5, 6].map((line) =>
      finding({
        id: `lint:src/value.ts:${line}`,
        location: { file: "src/value.ts", startLine: line },
      }),
    );

    const [result] = await enrichSourceExcerpts([completed(findings)], {
      snapshotRoot,
    });

    expect(
      result?.findings.map(({ sourceExcerpt }) => sourceExcerpt?.text),
    ).toEqual(["one", "two", "three", "four", "five", "six"]);
  });

  it("caps excerpts at 500 Unicode code points with a final ellipsis", async () => {
    const snapshotRoot = await sourceSnapshot(
      `one\ntwo\nthree\n${"🙂".repeat(501)}\n`,
    );

    const [result] = await enrichSourceExcerpts([completed([finding()])], {
      snapshotRoot,
    });
    const excerpt = result?.findings[0]?.sourceExcerpt;

    expect(excerpt).toEqual({
      line: 4,
      text: `${"🙂".repeat(499)}…`,
      redacted: false,
      truncated: true,
    });
    expect(Array.from(excerpt?.text ?? "")).toHaveLength(500);
  });

  it("streams a late excerpt without using the whole-file reader", async () => {
    readBoundary.containedFileReads.length = 0;
    readBoundary.forbidWholeFileReads = true;
    const snapshotRoot = await sourceSnapshot(
      `${"x".repeat(2_000_000)}\nexport const streamed = true;\n`,
    );
    const lateFinding = finding({
      id: "lint:src/value.ts:2",
      location: { file: "src/value.ts", startLine: 2 },
    });

    try {
      const [result] = await enrichSourceExcerpts(
        [completed([lateFinding, lateFinding])],
        { snapshotRoot },
      );

      expect(
        result?.findings.map(({ sourceExcerpt }) => sourceExcerpt?.text),
      ).toEqual([
        "export const streamed = true;",
        "export const streamed = true;",
      ]);
      expect(readBoundary.containedFileReads).toEqual([]);
    } finally {
      readBoundary.forbidWholeFileReads = false;
    }
  });

  it("omits unavailable and repository-level excerpts without changing findings", async () => {
    const snapshotRoot = await sourceSnapshot("export const value = 1;\n");
    const input = completed([
      finding({ id: "repository", location: undefined }),
      finding({
        id: "missing",
        location: { file: "src/missing.ts", startLine: 1 },
      }),
      finding({
        id: "out-of-range",
        location: { file: "src/value.ts", startLine: 9 },
      }),
    ]);

    const [result] = await enrichSourceExcerpts([input], { snapshotRoot });

    expect(result?.findings.map(({ id }) => id)).toEqual([
      "repository",
      "missing",
      "out-of-range",
    ]);
    expect(
      result?.findings.every(
        ({ sourceExcerpt }) => sourceExcerpt === undefined,
      ),
    ).toBe(true);
    expect(result).not.toBe(input);
    expect(result?.findings[0]).not.toBe(input.findings[0]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.findings)).toBe(true);
    expect(Object.isFrozen(result?.findings[0])).toBe(true);
  });

  it("preserves the public check field order while copying results", async () => {
    const snapshotRoot = await sourceSnapshot("export const value = 1;\n");
    const input: CheckResult = {
      checkId: "lint",
      target: "workspace",
      status: "incomplete",
      durationMs: 1,
      findings: [
        finding({
          id: "lint:src/value.ts:1",
          location: { file: "src/value.ts", startLine: 1 },
        }),
      ],
      error: { code: "LINT_FAILED", message: "Lint failed." },
    };

    const [result] = await enrichSourceExcerpts([input], { snapshotRoot });

    expect(Object.keys(result ?? {})).toEqual([
      "checkId",
      "target",
      "status",
      "durationMs",
      "findings",
      "error",
    ]);
    expect(Object.keys(result?.findings[0] ?? {})).toEqual([
      "id",
      "check",
      "rule",
      "severity",
      "message",
      "location",
      "sourceExcerpt",
      "attribution",
    ]);
  });

  it("redacts secret findings without invoking the source reader", async () => {
    readBoundary.containedFileReads.length = 0;
    const snapshotRoot = await sourceSnapshot(
      "one\ntwo\nthree\nSECRET-MUST-NOT-LEAK\n",
    );
    const secret = finding({
      id: "secret:src/value.ts:4",
      check: "secrets",
      rule: "generic-api-key",
      message: "A secret was detected.",
    });

    const results = await enrichSourceExcerpts([completed([secret])], {
      snapshotRoot,
    });

    expect(results[0]?.findings[0]?.sourceExcerpt).toEqual({
      line: 4,
      redacted: true,
      truncated: false,
    });
    expect(readBoundary.containedFileReads).toEqual([]);
    expect(JSON.stringify(results)).not.toContain("SECRET-MUST-NOT-LEAK");
  });

  it("redacts a non-secret finding whose line overlaps a secret range before reading source", async () => {
    readBoundary.containedFileReads.length = 0;
    const snapshotRoot = await sourceSnapshot(
      "one\ntwo\nthree\nRECOGNIZABLE-STAGED-SECRET\nfive\n",
    );
    const secret = finding({
      id: "secret:src/value.ts:3-5",
      check: "secrets",
      rule: "generic-api-key",
      message: "A secret was detected.",
      location: { file: "src\\value.ts", startLine: 3, endLine: 5 },
    });
    const lint = finding({
      id: "lint:src/value.ts:4",
      location: { file: "src/value.ts", startLine: 4, endLine: 4 },
    });

    const results = await enrichSourceExcerpts(
      [completed([lint]), completed([secret])],
      { snapshotRoot },
    );

    expect(results[0]?.findings[0]?.sourceExcerpt).toEqual({
      line: 4,
      redacted: true,
      truncated: false,
    });
    expect(results[1]?.findings[0]?.sourceExcerpt).toEqual({
      line: 3,
      redacted: true,
      truncated: false,
    });
    expect(readBoundary.containedFileReads).toEqual([]);
    expect(JSON.stringify(results)).not.toContain("RECOGNIZABLE-STAGED-SECRET");
  });
});
