import { describe, expect, it } from "vitest";
import { summarizeChecks } from "../../src/core/summarize.js";
import type { CheckResult } from "../../src/core/types.js";

describe("summarizeChecks", () => {
  it("sorts Unicode findings by code unit without consulting the host locale", () => {
    const finding = (check: string, id: string) => ({
      id,
      check,
      rule: "rule",
      severity: "warning" as const,
      message: "message",
      attribution: { kind: "none" as const, staged: false, evidence: [] },
    });
    const composed = finding("\u00e9", "composed");
    const decomposed = finding("e\u0301", "decomposed");
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("locale ordering must not be consulted");
    };
    try {
      expect(
        summarizeChecks([
          {
            checkId: "unicode",
            status: "completed",
            durationMs: 0,
            findings: [composed, decomposed],
          },
        ]).findings,
      ).toEqual([decomposed, composed]);
    } finally {
      String.prototype.localeCompare = original;
    }
  });

  it("counts outcomes and sorts findings deterministically", () => {
    const results: CheckResult[] = [
      {
        checkId: "formatting",
        status: "completed",
        durationMs: 8,
        findings: [
          {
            id: "second",
            check: "formatting",
            rule: "prettier",
            severity: "warning",
            message: "Format b.ts",
            location: { file: "b.ts", startLine: 2 },
            attribution: {
              kind: "range-overlap",
              staged: true,
              evidence: ["b.ts:2"],
            },
          },
          {
            id: "first",
            check: "formatting",
            rule: "prettier",
            severity: "error",
            message: "Format a.ts",
            location: { file: "a.ts", startLine: 1 },
            attribution: {
              kind: "range-overlap",
              staged: true,
              evidence: ["a.ts:1"],
            },
          },
        ],
      },
      {
        checkId: "types",
        status: "incomplete",
        durationMs: 3,
        findings: [],
        error: { code: "ENGINE_FAILED", message: "Compiler unavailable" },
      },
    ];

    expect(summarizeChecks(results)).toEqual({
      passed: 0,
      warnings: 1,
      failed: 1,
      incomplete: 1,
      findings: [results[0]!.findings[1], results[0]!.findings[0]],
    });
  });
});
