import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { sanitizeCheckResult } from "../../src/checks/sanitize-result.js";
import { validateReportableSnapshotPath } from "../../src/git/snapshot-path.js";
import { renderText } from "../../src/renderers/text.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

const fixtureGraphemes = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

function fixtureTerminalWidth(value: string): number {
  let width = 0;
  for (const { segment } of fixtureGraphemes.segment(value)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) {
      width += 2;
      continue;
    }
    for (const point of segment) {
      const codePoint = point.codePointAt(0)!;
      if (/\p{Mark}/u.test(point)) continue;
      width +=
        (codePoint >= 0x1100 && codePoint <= 0x115f) ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xff01 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6)
          ? 2
          : 1;
    }
  }
  return width;
}

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
          services: ["api.osv.dev"],
          metadata: [
            "package names",
            "exact versions",
            "ecosystem identifiers",
          ],
        },
      ],
    });

    expect(renderText(report, { width: 80, color: false })).toContain(
      "NETWORK DISCLOSURE\n  vulnerabilities sent package names, exact versions, ecosystem identifiers to\n  api.osv.dev.",
    );
  });

  it("renders stable actionable findings and incomplete diagnostics", async () => {
    const created = await mkdtemp(join(tmpdir(), "zedbee-snapshot-text-"));
    const canonicalSnapshotRoot = await realpath(created);
    onTestFinished(() => rm(canonicalSnapshotRoot, { recursive: true }));
    const finding = createFinding({
      check: "lint",
      rule: "no-unused-vars",
      message: "Variable is assigned but never used.",
      location: { file: "src/app.ts", startLine: 42, startColumn: 7 },
      remediation: "Remove it or use the value.",
      sourceExcerpt: {
        line: 42,
        text: "const unused = calculateValue()",
        redacted: false,
        truncated: false,
      },
    });
    const cleanup = sanitizeCheckResult(
      {
        checkId: "zedbee",
        status: "incomplete",
        durationMs: 4,
        findings: [],
        error: {
          code: "SNAPSHOT_CLEANUP_FAILED",
          message: "Zedbee could not remove its temporary snapshot.",
          path: "src/app.ts",
          remediation: "Remove the temporary directory manually.",
        },
      },
      {
        temporaryPath: validateReportableSnapshotPath(canonicalSnapshotRoot),
      },
    );
    const report = createReport({
      outcome: "incomplete",
      exitCode: 2,
      summary: {
        passed: 2,
        warnings: 0,
        failed: 1,
        incomplete: 1,
        findings: [finding],
      },
      checks: [cleanup],
    });

    const output = renderText(report, { width: 60, color: false });
    const completeDiagnosticOutput = renderText(report, {
      width: 120,
      color: false,
    });

    expect(output).toContain(
      "ESLint  no-unused-vars                         src/app.ts:42",
    );
    expect(output).toContain("  42 │ const unused = calculateValue()");
    expect(output).toContain(
      "       Issue: Variable is assigned but never used.",
    );
    expect(output).toContain("       Fix: Remove it or use the value.");
    expect(output).toContain("SNAPSHOT CLEANUP FAILED");
    expect(output).toContain("Zedbee could not remove its temporary snapshot.");
    expect(output).toContain("src/app.ts");
    expect(output).toContain("Remove the temporary directory manually.");
    expect(completeDiagnosticOutput).toContain(canonicalSnapshotRoot);
    expect(output.indexOf("SNAPSHOT CLEANUP FAILED")).toBeLessThan(
      output.indexOf("ESLint  no-unused-vars"),
    );
    expect(output).not.toContain("1 incomplete");
    expect(
      Math.max(...output.split("\n").map((line) => [...line].length)),
    ).toBeLessThanOrEqual(60);
  });

  it("stacks finding locations and wraps descriptions at 40 columns", () => {
    const finding = createFinding({
      check: "lint",
      rule: "no-unused-vars",
      message: "Variable is assigned but never used.",
      location: { file: "src/app.ts", startLine: 42, startColumn: 7 },
      remediation: "Remove it or use the value.",
      sourceExcerpt: {
        line: 42,
        text: "const unused = calculateValue()",
        redacted: false,
        truncated: false,
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

    const output = renderText(report, { width: 40, color: false });

    expect(output).toContain(
      [
        "ESLint  no-unused-vars",
        "                           src/app.ts:42",
        "  42 │ const unused = calculateValue()",
        "       Issue: Variable is assigned but",
        "              never used.",
        "       Fix: Remove it or use the value.",
      ].join("\n"),
    );
    expect(
      Math.max(...output.split("\n").map((line) => [...line].length)),
    ).toBeLessThanOrEqual(40);
  });

  it("renders secret source excerpts as redacted without secret text", () => {
    const finding = createFinding({
      check: "secrets",
      rule: "generic-api-key",
      location: { file: "src/app.ts", startLine: 42 },
      sourceExcerpt: {
        line: 42,
        text: "sk-live-seeded-secret",
        redacted: false,
        truncated: false,
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

    const output = renderText(report, { width: 60, color: false });

    expect(output).toContain("42 │ [redacted]");
    expect(output).not.toContain("sk-live-seeded-secret");
  });

  it("renders findings in deterministic report order without file groups", () => {
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
    expect(output.match(/src\/value\.ts/g)).toHaveLength(2);
    expect(output).toContain("Prettier  prettier");
    expect(output).toContain("Prettier  other-rule");
    expect(output).toContain(
      "Fix: Format the staged lines, then stage the result.",
    );
  });

  it("preserves the check and rule separator for repository findings", () => {
    const { location: _location, ...finding } = createFinding();
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

    expect(renderText(report, { width: 40, color: false })).toContain(
      "Prettier  prettier",
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
          incompleteDisposition: "block",
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
    expect(renderText(report, { width: 80, color: false })).toContain(
      "Availability: commit blocked (onUnavailable: block)",
    );
  });

  it("explains a non-blocking incomplete availability result", () => {
    const report = createReport({
      outcome: "pass",
      exitCode: 0,
      summary: {
        passed: 0,
        warnings: 0,
        failed: 0,
        incomplete: 1,
        findings: [],
      },
      checks: [
        {
          checkId: "vulnerabilities",
          status: "incomplete",
          incompleteDisposition: "warn",
          durationMs: 2,
          findings: [],
          error: {
            code: "OSV_UNAVAILABLE",
            message: "OSV is temporarily unavailable.",
          },
        },
      ],
    });

    const output = renderText(report, { width: 80, color: false });
    expect(output).toContain(
      "Availability: commit allowed (onUnavailable: warn)",
    );
    expect(output).not.toContain("1 incomplete");
  });

  it("omits incomplete from visual outcome counts", () => {
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

    const output = renderText(report, { width: 80, color: false });

    expect(output).toContain("3 passed · 2 warnings · 1 failed");
    expect(output).not.toContain("1 incomplete");
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

  it("replaces a bidi format control before rendering source text", () => {
    const finding = createFinding({
      sourceExcerpt: {
        line: 2,
        text: "const BIDI_MARKER = 'before\u202eafter';",
        redacted: false,
        truncated: false,
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

    const output = renderText(report, { width: 80, color: false });

    expect(output).toContain("BIDI_MARKER = 'before�after'");
    expect(output).not.toContain("\u202e");
  });

  it("bounds every text line at the minimum 20-column width", () => {
    const finding = createFinding({
      check: "dependencyArchitecture",
      rule: "a-very-long-rule-name-without-breaks",
      message: "A long diagnostic message that needs multiple lines.",
      location: {
        file: "packages/application/src/very-long-file-name.ts",
        startLine: 1234,
      },
      sourceExcerpt: {
        line: 1234,
        text: "const veryLongIdentifierWithoutWhitespace = true;",
        redacted: false,
        truncated: true,
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

    const output = renderText(report, { width: 20, color: false });

    expect(
      Math.max(...output.split("\n").map((line) => [...line].length)),
    ).toBeLessThanOrEqual(20);
    expect(output).not.toMatch(/\u001B\[[0-9;]*m/u);
  });

  it.each([20, 40])(
    "bounds CJK, combining, and emoji report content to %i terminal cells",
    (width) => {
      const finding = createFinding({
        check: "lint",
        rule: "界面-rule",
        message: "修复界面 cafe\u0301 与 emoji 🚀 message now.",
        location: { file: "src/界面/组件.ts", startLine: 42 },
        remediation: "修复配置并重试 cafe\u0301 🚀 safely.",
        sourceExcerpt: {
          line: 42,
          text: "cafe\u0301 🚀 界面 source",
          redacted: false,
          truncated: false,
        },
      });
      const report = createReport({
        outcome: "incomplete",
        exitCode: 2,
        checks: [
          {
            checkId: "lint",
            status: "incomplete",
            durationMs: 1,
            findings: [],
            error: {
              code: "ANALYSIS_FAILED",
              message: "界面检查无法完成 cafe\u0301 🚀 message.",
              path: "src/界面/组件.ts",
              remediation: "修复配置并重试 cafe\u0301 🚀 safely.",
            },
          },
        ],
        summary: {
          passed: 0,
          warnings: 0,
          failed: 1,
          incomplete: 1,
          findings: [finding],
        },
      });

      const output = renderText(report, { width, color: false });

      expect(output).toContain("cafe\u0301");
      expect(output).toContain("🚀");
      expect(
        Math.max(...output.split("\n").map(fixtureTerminalWidth)),
      ).toBeLessThanOrEqual(width);
      expect(output).not.toMatch(/e\n\u0301/u);
    },
  );

  it("consumes a producer-truncated excerpt without duplicating its ellipsis", () => {
    const finding = createFinding({
      sourceExcerpt: {
        line: 2,
        text: "const bounded = value…",
        redacted: false,
        truncated: true,
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

    const output = renderText(report, { width: 60, color: false });

    expect(output).toContain("2 │ const bounded = value…");
    expect(output.match(/…/gu)).toHaveLength(1);
    expect(output).not.toContain("……");
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
