import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { sanitizeCheckResult } from "../../src/checks/sanitize-result.js";
import { validateReportableSnapshotPath } from "../../src/git/snapshot-path.js";
import { nextStepsLines } from "../../src/reporting/next-steps.js";
import type { TerminalPresentation } from "../../src/reporting/presentation.js";
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
  it("renders automatic sections and callouts in stable linear order", () => {
    const blocking = createFinding({ id: "blocking", rule: "blocking" });
    const warning = createFinding({
      id: "warning",
      severity: "warning",
      rule: "warning",
    });
    const report = createReport({
      outcome: "incomplete",
      exitCode: 2,
      summary: {
        passed: 1,
        warnings: 1,
        failed: 1,
        incomplete: 1,
        findings: [blocking, warning],
      },
      networkDisclosures: [
        {
          checkId: "vulnerabilities",
          target: ".",
          services: ["api.osv.dev"],
          metadata: ["package names"],
        },
      ],
      checks: [
        {
          checkId: "vulnerabilities",
          status: "incomplete",
          incompleteDisposition: "block",
          durationMs: 2,
          findings: [],
          error: { code: "OSV_UNAVAILABLE", message: "OSV is unavailable." },
        },
      ],
      presentationPolicy: {
        terminalFindingLimit: 1,
        temporaryReportMaxAge: "24h",
        persistSourceExcerpts: false,
        agentGuidance: {
          opening: "Read the complete report.",
          nextStep: "Resolve blocking findings.",
        },
      },
    });
    const output = renderText(report, {
      width: 100,
      color: false,
      presentation: {
        automatic: true,
        reportStatus: "available",
        findings: [blocking, warning],
        totalFindingCount: 2,
        abbreviated: true,
        reportPath: "/private/tmp/zedbee-reports/complete.json",
        maximumAge: "24h",
        warnings: [
          {
            code: "TEMP_REPORT_CLEANUP_FAILED",
            message: "An older report could not be removed.",
          },
        ],
      },
    });

    const headings = [
      "AGENT GUIDANCE",
      "COMPLETE REPORT",
      "BLOCKING FINDINGS",
      "WARNINGS",
      "DISCLOSURES",
      "REPORT WARNINGS",
      "INCOMPLETE CHECKS",
      "SCAN RESULT",
      "AGENT NEXT STEP",
      "COMPLETE REPORT",
    ];
    let prior = -1;
    for (const heading of headings) {
      const index = output.indexOf(heading, prior + 1);
      expect(index).toBeGreaterThan(prior);
      prior = index;
    }
    expect(
      output.lastIndexOf("/private/tmp/zedbee-reports/complete.json"),
    ).toBeGreaterThan(output.indexOf("REPORT WARNINGS"));
  });

  it("omits blank automatic guidance headings while keeping complete-report callouts", () => {
    const report = createReport({
      presentationPolicy: {
        terminalFindingLimit: 25,
        temporaryReportMaxAge: "24h",
        persistSourceExcerpts: false,
        agentGuidance: { opening: "", nextStep: "" },
      },
    });
    const output = renderText(report, {
      width: 100,
      color: false,
      presentation: {
        automatic: true,
        reportStatus: "available",
        findings: [],
        totalFindingCount: 0,
        abbreviated: false,
        reportPath: "/private/tmp/zedbee-reports/complete.json",
        maximumAge: "24h",
        warnings: [],
      },
    });

    expect(output).not.toContain("AGENT GUIDANCE");
    expect(output).not.toContain("AGENT NEXT STEP");
    expect(output.match(/COMPLETE REPORT/g)).toHaveLength(2);
    expect(output).toContain("SCAN RESULT");
  });

  it("keeps the complete pass, warning, and failure counts in automatic linear output", () => {
    const report = createReport({
      summary: {
        passed: 1,
        warnings: 2,
        failed: 0,
        incomplete: 0,
        findings: [],
      },
    });
    const output = renderText(report, {
      width: 100,
      color: false,
      presentation: {
        automatic: true,
        reportStatus: "available",
        findings: [],
        totalFindingCount: 0,
        abbreviated: false,
        reportPath: "/private/tmp/zedbee-reports/complete.json",
        maximumAge: "24h",
        warnings: [],
      },
    });

    expect(output).toContain(
      "1 check passed · 0 blocking findings · 2 warning findings",
    );
  });

  it("directs an automatic incomplete scan to the details above its final result", () => {
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
          checkId: "lint",
          status: "incomplete",
          incompleteDisposition: "block",
          durationMs: 2,
          findings: [],
          error: {
            code: "TYPED_LINT_PROJECT_MISMATCH",
            message:
              "Zedbee found TypeScript files outside its loaded projects.",
            path: "docs/config.mts",
            paths: ["docs/config.mts", "docs/theme.ts"],
            snapshot: "last-commit",
            projectPaths: ["tools/tsconfig.json"],
          },
        },
      ],
    });
    const output = renderText(report, {
      width: 60,
      color: false,
      presentation: {
        automatic: true,
        reportStatus: "available",
        findings: [],
        totalFindingCount: 0,
        abbreviated: false,
        reportPath: "/private/tmp/zedbee-reports/complete.json",
        maximumAge: "24h",
        warnings: [],
      },
    });

    expect(output.indexOf("INCOMPLETE CHECKS")).toBeLessThan(
      output.indexOf("SCAN RESULT"),
    );
    expect(output).toContain("Checked version: Previous commit");
    expect(output).toContain("Loaded project: tools/tsconfig.json");
    expect(output).toContain("Affected files: 2");
    expect(output).toContain("docs/config.mts");
    expect(output).toContain("docs/theme.ts");
    expect(output).toMatch(
      /A required check could not finish\. Review INCOMPLETE CHECKS\s+above for details\. Commit blocked\./u,
    );
  });

  it("prints fixed complete-output callouts and every finding when automatic report persistence fails", () => {
    const first = createFinding({ id: "first", rule: "first" });
    const second = createFinding({ id: "second", rule: "second" });
    const report = createReport({
      outcome: "blocked",
      exitCode: 1,
      summary: {
        passed: 0,
        warnings: 0,
        failed: 2,
        incomplete: 0,
        findings: [first, second],
      },
      presentationPolicy: {
        terminalFindingLimit: 1,
        temporaryReportMaxAge: "24h",
        persistSourceExcerpts: false,
        agentGuidance: {
          opening: "Read the report.",
          nextStep: "Use the report.",
        },
      },
    });
    const output = renderText(report, {
      width: 100,
      color: false,
      presentation: {
        automatic: true,
        reportStatus: "unavailable",
        findings: [first, second],
        totalFindingCount: 2,
        abbreviated: false,
        completeOutputFallback: true,
        warnings: [
          {
            code: "TEMP_REPORT_WRITE_FAILED",
            message: "The temporary report could not be written.",
          },
        ],
      },
    });

    expect(output.match(/REPORT UNAVAILABLE/g)).toHaveLength(2);
    expect(output).toContain(
      "The terminal output is the complete source of truth.",
    );
    expect(output).toContain("first");
    expect(output).toContain("second");
    expect(output).not.toContain("AGENT GUIDANCE");
    expect(output).not.toContain("AGENT NEXT STEP");
    expect(output).not.toContain("/private/tmp/zedbee-reports/complete.json");
  });

  it("keeps explicit text complete and free of automatic callouts", () => {
    const finding = createFinding({ id: "complete", rule: "complete" });
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

    const output = renderText(report, { width: 100, color: false });

    expect(output).toContain("THAT STINGS");
    expect(output).toContain("complete");
    expect(output).not.toContain("AGENT GUIDANCE");
    expect(output).not.toContain("COMPLETE REPORT");
    expect(output).not.toContain("SCAN RESULT");
  });

  it("renders managed commands in complete non-abbreviated text", () => {
    const finding = createFinding({
      check: "lint",
      automaticFix: {
        available: true,
        command: ["npx", "--no-install", "zedbee", "fix", "lint"],
        scope: "finding",
        writes: "working-tree",
        stagesChanges: false,
      },
    });
    const output = renderText(
      createReport({
        outcome: "blocked",
        exitCode: 1,
        summary: {
          passed: 0,
          warnings: 0,
          failed: 1,
          incomplete: 0,
          findings: [finding],
        },
      }),
      { width: 100, color: false },
    );

    expect(output).toContain("NEXT STEP");
    expect(output.match(/npx --no-install zedbee fix lint/gu)).toHaveLength(1);
  });

  it("integrates abbreviated automatic commands into the closing callout once", () => {
    const finding = createFinding({
      check: "lint",
      automaticFix: {
        available: true,
        command: ["npx", "--no-install", "zedbee", "fix", "lint"],
        scope: "finding",
        writes: "working-tree",
        stagesChanges: false,
      },
    });
    const reportPath = "/private/tmp/zedbee-reports/complete.json";
    const output = renderText(
      createReport({
        outcome: "blocked",
        exitCode: 1,
        summary: {
          passed: 0,
          warnings: 0,
          failed: 2,
          incomplete: 0,
          findings: [finding, createFinding({ id: "hidden" })],
        },
        presentationPolicy: {
          terminalFindingLimit: 1,
          temporaryReportMaxAge: "24h",
          persistSourceExcerpts: false,
          agentGuidance: { opening: "", nextStep: "Apply the managed fix." },
        },
      }),
      {
        width: 100,
        color: false,
        presentation: {
          automatic: true,
          reportStatus: "available",
          findings: [finding],
          totalFindingCount: 2,
          abbreviated: true,
          reportPath,
          maximumAge: "24h",
          warnings: [],
        },
      },
    );

    expect(output).not.toContain("NEXT STEPS");
    expect(output.match(/Showing 1 of 2 findings\./gu)).toHaveLength(1);
    expect(output.match(/complete\.json/gu)).toHaveLength(2);
    expect(output.match(/npx --no-install zedbee fix lint/gu)).toHaveLength(1);
    expect(output.indexOf("AGENT NEXT STEP")).toBeLessThan(
      output.indexOf("npx --no-install zedbee fix lint"),
    );
  });

  it("provides neutral outcome-aware guidance for abbreviated reports", () => {
    const base = {
      shown: 25,
      total: 712,
      reportPath: "/temporary/path/zedbee-report.json",
      maximumAge: "24h",
    } as const;

    expect(nextStepsLines({ ...base, outcome: "blocked" })).toEqual([
      "NEXT STEPS",
      "",
      "Showing 25 of 712 findings.",
      'Full report: "/temporary/path/zedbee-report.json"',
      "Zedbee will remove this report on the first run after 24 hours.",
      "The operating system may remove it sooner.",
      "",
      "Fix every blocking finding, stage the changes, then run Zedbee again.",
      "The terminal output is abbreviated; do not treat it as the complete report.",
    ]);
    expect(nextStepsLines({ ...base, outcome: "pass" })).toContain(
      "Review every warning, make any appropriate changes, and run Zedbee again when changes are made.",
    );
    expect(nextStepsLines({ ...base, outcome: "incomplete" })).toContain(
      "Restore every required incomplete check, then run Zedbee again.",
    );
    expect(nextStepsLines({ ...base, outcome: "incomplete" })).toContain(
      "Do not treat the scan as clean.",
    );
    expect(
      nextStepsLines({ ...base, outcome: "blocked" }).join("\n"),
    ).not.toMatch(/\bAI\b|Claude|Codex|Copilot/iu);
    expect(
      nextStepsLines({ ...base, outcome: "blocked", maximumAge: "1h" }),
    ).toContain(
      "Zedbee will remove this report on the first run after 1 hour.",
    );
  });

  it("lists each managed fix command once in abbreviated next steps", () => {
    const lines = nextStepsLines({
      outcome: "blocked",
      shown: 2,
      total: 3,
      reportPath: "/temporary/path/zedbee-report.json",
      maximumAge: "24h",
      automaticFixes: [
        {
          available: true,
          command: ["npx", "--no-install", "zedbee", "fix", "lint"],
          scope: "finding",
          writes: "working-tree",
          stagesChanges: false,
        },
        {
          available: true,
          command: ["npx", "--no-install", "zedbee", "fix", "lint"],
          scope: "finding",
          writes: "working-tree",
          stagesChanges: false,
        },
        {
          available: true,
          command: ["npx", "--no-install", "zedbee", "fix", "formatting"],
          scope: "working-file",
          writes: "working-tree",
          stagesChanges: false,
        },
      ],
    } as Parameters<typeof nextStepsLines>[0]);

    expect(lines).toContain(
      "Managed fix commands write the working tree; they do not stage changes.",
    );
    expect(
      lines.filter((line) => line === "npx --no-install zedbee fix lint"),
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line === "npx --no-install zedbee fix formatting"),
    ).toHaveLength(1);
  });

  it("renders only preview findings while retaining canonical diagnostics and disclosures", () => {
    const shown = createFinding({ id: "shown", rule: "shown-rule" });
    const hidden = createFinding({ id: "hidden", rule: "hidden-rule" });
    const report = createReport({
      outcome: "incomplete",
      exitCode: 2,
      checks: [
        {
          checkId: "vulnerabilities",
          status: "incomplete",
          incompleteDisposition: "block",
          durationMs: 2,
          findings: [],
          error: {
            code: "OSV_UNAVAILABLE",
            message: "OSV is temporarily unavailable.",
          },
        },
      ],
      summary: {
        passed: 4,
        warnings: 3,
        failed: 2,
        incomplete: 1,
        findings: [shown, hidden],
      },
      networkDisclosures: [
        {
          checkId: "vulnerabilities",
          target: ".",
          services: ["api.osv.dev"],
          metadata: ["package names"],
        },
      ],
    });
    const presentation: TerminalPresentation = {
      automatic: true,
      reportStatus: "available",
      findings: [shown],
      totalFindingCount: 2,
      abbreviated: true,
      reportPath: "/private/tmp/zedbee-reports/hash/full.json",
      maximumAge: "24h",
      warnings: [],
    };

    const output = renderText(report, {
      width: 80,
      color: false,
      presentation,
    });

    expect(output).toContain("SCAN RESULT");
    expect(output).toContain(
      "4 checks passed · 2 blocking findings · 3 warning findings",
    );
    expect(output).toContain("OSV UNAVAILABLE");
    expect(output).toContain("DISCLOSURES");
    expect(output).toContain("shown-rule");
    expect(output).not.toContain("hidden-rule");
    expect(output).toContain("COMPLETE REPORT");
  });

  it("renders maintenance warnings even when terminal output is complete", () => {
    const report = createReport();
    const cleanupPath =
      "/private/tmp/zedbee-reports/0123456789abcdef0123456789abcdef/stuck.json";
    const presentation: TerminalPresentation = {
      automatic: false,
      reportStatus: "not-requested",
      findings: report.summary.findings,
      totalFindingCount: 0,
      abbreviated: false,
      warnings: [
        {
          code: "TEMP_REPORT_CLEANUP_FAILED",
          message: "A retained report could not be removed.",
          path: cleanupPath,
        },
      ],
    };

    const output = renderText(report, {
      width: 40,
      color: false,
      presentation,
    });

    expect(output).toContain("REPORT MAINTENANCE WARNING");
    expect(output.replaceAll(/\s/gu, "")).toContain(
      "A retained report could not be removed.".replaceAll(/\s/gu, ""),
    );
    expect(output.match(/Path:/gu)).toHaveLength(1);
    expect(output.replaceAll(/\s/gu, "")).toContain(
      cleanupPath.replaceAll(/\s/gu, ""),
    );
    expect(output).not.toContain("NEXT STEPS");
  });

  it("ends automatic report persistence failure with a fixed complete-output notice", () => {
    const finding = createFinding({ id: "complete", rule: "complete-rule" });
    const report = createReport({
      summary: {
        passed: 0,
        warnings: 0,
        failed: 1,
        incomplete: 0,
        findings: [finding],
      },
    });
    const presentation: TerminalPresentation = {
      automatic: true,
      reportStatus: "unavailable",
      findings: report.summary.findings,
      totalFindingCount: report.summary.findings.length,
      abbreviated: false,
      completeOutputFallback: true,
      warnings: [
        {
          code: "TEMP_REPORT_WRITE_FAILED",
          message: "Temporary-report tracking could not be saved.",
        },
      ],
    };

    const output = renderText(report, {
      width: 80,
      color: false,
      presentation,
    });

    expect(output.match(/REPORT UNAVAILABLE/g)).toHaveLength(2);
    expect(output).toContain("REPORT WARNINGS");
    expect(
      output
        .trimEnd()
        .endsWith("The terminal output is the complete source of truth."),
    ).toBe(true);
  });

  it("renders a spaced report path as one opaque value at narrow width", () => {
    const finding = createFinding({ id: "shown", rule: "shown-rule" });
    const report = createReport({
      outcome: "blocked",
      exitCode: 1,
      summary: {
        passed: 0,
        warnings: 0,
        failed: 2,
        incomplete: 0,
        findings: [finding, createFinding({ id: "hidden" })],
      },
    });
    const reportPath =
      "/private/tmp/zedbee reports/0123456789abcdef0123456789abcdef/full report.json";
    const presentation: TerminalPresentation = {
      automatic: true,
      reportStatus: "available",
      findings: [finding],
      totalFindingCount: 2,
      abbreviated: true,
      reportPath,
      maximumAge: "24h",
      warnings: [],
    };

    const output = renderText(report, {
      width: 20,
      color: false,
      presentation,
    });

    expect(output).not.toMatch(/\u001B\[[0-9;]*m/u);
    expect(output.replaceAll("\n", "")).toContain(
      JSON.stringify(reportPath).replaceAll(" ", "\\u0020"),
    );
    expect(
      Math.max(...output.split("\n").map(fixtureTerminalWidth)),
    ).toBeLessThanOrEqual(20);
  });

  it.each([
    "/tmp/report\u001b[31m.json",
    "/tmp/report\n.json",
    "/tmp/report\u202e.json",
  ])("rejects an unsafe report path before rendering %j", (reportPath) => {
    expect(() =>
      nextStepsLines({
        shown: 1,
        total: 2,
        outcome: "blocked",
        reportPath,
        maximumAge: "24h",
      }),
    ).toThrow(/safe temporary report path display text/u);
  });

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
      changedFileCount: 0,
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
      changedFileCount: 1,
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

  it("uses white section names, gray body text, and yellow remediation when color is enabled", () => {
    const finding = createFinding({
      message: "A blocking issue was found.",
      remediation: "Run the managed fix.",
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

    const output = renderText(report, { width: 80, color: true });

    expect(output).toContain("\u001b[38;5;231mTHAT STINGS");
    expect(output).toContain("\u001b[38;5;145mA check failed. Commit blocked.");
    expect(output).toContain("\u001b[38;5;231mPrettier  prettier");
    expect(output).toContain("\u001b[38;5;145m       Issue:");
    expect(output).toContain("\u001b[38;5;221m       Fix:");
  });

  it("colors the Fix label and zedbee fix command yellow while keeping its explanation white", () => {
    const finding = createFinding({
      remediation:
        "Run npx --no-install zedbee fix formatting, then stage the result.",
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

    const output = renderText(report, { width: 100, color: true });

    expect(output).toContain(
      "\u001b[38;5;221m       Fix:\u001b[39m" +
        "\u001b[38;5;231m Run npx --no-install \u001b[39m" +
        "\u001b[38;5;221mzedbee fix\u001b[39m" +
        "\u001b[38;5;231m formatting, then stage the result.\u001b[39m",
    );
  });

  it("renders every managed finding check name in white", () => {
    const finding = createFinding({ check: "structuralSecurity" });
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

    expect(renderText(report, { width: 80, color: true })).toContain(
      "\u001b[38;5;231mast-grep  prettier",
    );
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
