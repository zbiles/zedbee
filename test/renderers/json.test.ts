import { describe, expect, it } from "vitest";
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
});
