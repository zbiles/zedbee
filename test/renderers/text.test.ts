import { describe, expect, it } from "vitest";
import { renderText } from "../../src/renderers/text.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

describe("renderText", () => {
  it("renders a concise passing report", () => {
    expect(renderText(createReport(), { width: 80, color: false })).toBe(
      [
        "BEE-UTIFUL",
        "All checks passed. Commit allowed.",
        "1 passed · 0 warnings",
        "",
      ].join("\n"),
    );
  });

  it("renders an empty staged change as a successful no-op", () => {
    const report = createReport({
      stagedFileCount: 0,
      checks: [],
      summary: {
        passed: 0,
        warnings: 0,
        failed: 0,
        incomplete: 0,
        findings: [],
      },
    });

    expect(renderText(report, { width: 80, color: false })).toContain(
      "No staged changes. Commit allowed.",
    );
  });

  it("does not report staged files as empty when every check is disabled", () => {
    const report = createReport({
      stagedFileCount: 1,
      checks: [],
      summary: {
        passed: 0,
        warnings: 0,
        failed: 0,
        incomplete: 0,
        findings: [],
      },
    });

    expect(renderText(report, { width: 80, color: false })).toContain(
      "All checks passed. Commit allowed.",
    );
  });

  it("persists online vulnerability metadata disclosure in text output", () => {
    const report = createReport({
      networkDisclosures: [
        {
          checkId: "vulnerabilities",
          target: ".",
          services: ["api.osv.dev", "api.deps.dev"],
          metadata: ["package names", "versions"],
        },
      ],
    });

    expect(renderText(report, { width: 80, color: false })).toContain(
      "NETWORK DISCLOSURE\n  vulnerabilities sent package names, versions to api.osv.dev, api.deps.dev.",
    );
  });

  it("groups blocking findings by repository-relative file", () => {
    const first = createFinding();
    const second = createFinding({
      id: "finding-2",
      rule: "other-rule",
      severity: "warning",
      location: { file: "src/value.ts", startLine: 5, endLine: 5 },
      message: "A second issue.",
    });
    const report = createReport({
      outcome: "blocked",
      exitCode: 1,
      summary: {
        passed: 2,
        warnings: 1,
        failed: 1,
        incomplete: 0,
        findings: [first, second],
      },
      checks: [
        {
          checkId: "formatting",
          status: "completed",
          durationMs: 4,
          findings: [first, second],
        },
      ],
    });

    const output = renderText(report, { width: 80, color: false });

    expect(output).toContain("THAT STINGS\nA check failed. Commit blocked.");
    expect(output).toContain("2 passed · 1 warning · 1 failed");
    expect(output.match(/src\/value\.ts/g)).toHaveLength(1);
    expect(output).toContain("2:1  ERROR  formatting/prettier");
    expect(output).toContain("5:1  WARNING  formatting/other-rule");
    expect(output).toContain(
      "Fix: Format the staged lines, then stage the result.",
    );
  });

  it("renders incomplete analysis distinctly", () => {
    const report = createReport({
      outcome: "incomplete",
      exitCode: 2,
      summary: {
        passed: 0,
        warnings: 0,
        failed: 0,
        incomplete: 1,
        findings: [],
      },
      checks: [
        {
          checkId: "formatting",
          status: "incomplete",
          durationMs: 2,
          findings: [],
          error: {
            code: "PRETTIER_FAILED",
            message: "Prettier could not analyze value.ts",
          },
        },
      ],
    });

    expect(renderText(report, { width: 80, color: false })).toContain(
      "SCAN INCOMPLETE\nA required check could not finish. Commit blocked.",
    );
  });

  it("includes every outcome count in incomplete text output", () => {
    const report = createReport({
      outcome: "incomplete",
      exitCode: 2,
      summary: {
        passed: 3,
        warnings: 2,
        failed: 1,
        incomplete: 1,
        findings: [],
      },
    });

    expect(renderText(report, { width: 80, color: false })).toContain(
      "3 passed · 2 warnings · 1 failed · 1 incomplete",
    );
  });

  it("wraps long messages and never emits ANSI when color is disabled", () => {
    const finding = createFinding({
      message:
        "This message contains enough words that it must wrap within a narrow terminal width.",
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
    });

    const output = renderText(report, { width: 44, color: false });

    expect(output).not.toMatch(/\u001B\[[0-9;]*m/);
    expect(
      Math.max(...output.split("\n").map((line) => line.length)),
    ).toBeLessThanOrEqual(44);
  });

  it("shows sorted sanitized attribution evidence only in verbose output", () => {
    const finding = createFinding({
      attribution: {
        kind: "range-overlap",
        staged: true,
        evidence: ["target-only:abc", "staged-range:src/value.ts:2-2"],
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
    });

    expect(renderText(report, { width: 80, color: false })).not.toContain(
      "Attribution:",
    );
    expect(
      renderText(report, { width: 80, color: false, verbose: true }),
    ).toContain(
      "Attribution: range-overlap · staged-range:src/value.ts:2-2 · target-only:abc",
    );
  });

  it("rejects terminal control sequences at the renderer boundary", () => {
    const finding = createFinding({ message: "unsafe\u001b[2Joutput" });
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
    });

    expect(() => renderText(report, { width: 80, color: false })).toThrow(
      /display text/i,
    );
  });
});
