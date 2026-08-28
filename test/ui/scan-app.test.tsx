import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ScanEvent } from "../../src/checks/events.js";
import { sanitizeCheckResult } from "../../src/checks/sanitize-result.js";
import { ScanApp } from "../../src/ui/scan-app.js";
import type { TerminalPresentation } from "../../src/reporting/presentation.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

const events: ScanEvent[] = [
  { type: "check-queued", checkId: "formatting", target: ".", timestamp: 1 },
  { type: "check-running", checkId: "formatting", target: ".", timestamp: 2 },
];

describe("ScanApp", () => {
  it("renders managed commands for complete explicit Ink output", () => {
    const finding = createFinding({
      check: "formatting",
      automaticFix: {
        available: true,
        command: ["npx", "--no-install", "zedbee", "fix", "formatting"],
        scope: "working-file",
        writes: "working-tree",
        stagesChanges: false,
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
    const frame = render(
      <ScanApp
        events={events}
        elapsedMs={15}
        width={96}
        color={false}
        animations={false}
        report={report}
        presentation={{
          automatic: false,
          reportStatus: "not-requested",
          findings: [finding],
          totalFindingCount: 1,
          abbreviated: false,
          warnings: [],
        }}
      />,
    ).lastFrame()!;

    expect(frame).toContain("NEXT STEP");
    expect(frame).toContain("npx --no-install zedbee fix formatting");
  });

  it("renders opaque report and warning paths at narrow width", () => {
    const previousNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    const shown = createFinding({ id: "shown", rule: "shown-rule" });
    const hidden = createFinding({ id: "hidden", rule: "hidden-rule" });
    const report = createReport({
      outcome: "blocked",
      exitCode: 1,
      summary: {
        passed: 3,
        warnings: 1,
        failed: 2,
        incomplete: 0,
        findings: [shown, hidden],
      },
    });
    const reportPath =
      "/private/tmp/zedbee reports/0123456789abcdef0123456789abcdef/full report.json";
    const warningPath = "/private/tmp/zedbee reports/hash/stuck report.json";
    const presentation: TerminalPresentation = {
      automatic: true,
      reportStatus: "available",
      findings: [shown],
      totalFindingCount: 2,
      abbreviated: true,
      reportPath,
      maximumAge: "24h",
      warnings: [
        {
          code: "TEMP_REPORT_CLEANUP_FAILED",
          message: "A retained report could not be removed.",
          path: warningPath,
        },
      ],
    };

    let frame: string;
    try {
      frame = render(
        <ScanApp
          events={events}
          elapsedMs={15}
          width={20}
          color={false}
          animations={false}
          report={report}
          presentation={presentation}
        />,
      ).lastFrame()!;
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }

    expect(frame).toContain("3 passed · 1");
    expect(frame).toContain("warning · 2");
    expect(frame).toContain("shown-rule");
    expect(frame).not.toContain("hidden-rule");
    expect(frame.replaceAll("\n", " ")).toContain("REPORT MAINTENANCE WARNING");
    expect(frame).toContain("NEXT STEPS");
    expect(frame.replaceAll("\n", "")).toContain(
      JSON.stringify(reportPath).replaceAll(" ", "\\u0020"),
    );
    expect(frame.replaceAll("\n", "")).toContain(
      JSON.stringify(warningPath).replaceAll(" ", "\\u0020"),
    );
    expect(frame).not.toMatch(/\u001B\[[0-9;]*m/u);
    expect(frame).not.toMatch(/\bAI\b|Claude|Codex|Copilot/iu);
    expect(
      Math.max(...frame.split("\n").map((line) => [...line].length)),
    ).toBeLessThanOrEqual(20);
  });

  it("keeps complete final output backward compatible without a presentation", () => {
    const first = createFinding({ id: "first", rule: "first-rule" });
    const second = createFinding({ id: "second", rule: "second-rule" });
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
    });

    const frame = render(
      <ScanApp
        events={events}
        elapsedMs={15}
        width={96}
        color={false}
        animations={false}
        report={report}
      />,
    ).lastFrame()!;

    expect(frame).toContain("first-rule");
    expect(frame).toContain("second-rule");
    expect(frame).not.toContain("NEXT STEPS");
  });

  it("ends complete fallback output with the report delivery warning", () => {
    const finding = createFinding({ id: "shown", rule: "shown-rule" });
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
    const presentation: TerminalPresentation = {
      automatic: true,
      reportStatus: "unavailable",
      findings: [finding],
      totalFindingCount: 1,
      abbreviated: false,
      completeOutputFallback: true,
      warnings: [
        {
          code: "TEMP_REPORT_WRITE_FAILED",
          message: "The temporary report could not be retained.",
        },
      ],
    };

    const frame = render(
      <ScanApp
        events={events}
        elapsedMs={15}
        width={96}
        color={false}
        animations={false}
        report={report}
        presentation={presentation}
      />,
    ).lastFrame()!;

    expect(frame).toContain("shown-rule");
    expect(frame.indexOf("REPORT MAINTENANCE WARNING")).toBeLessThan(
      frame.indexOf("REPORT DELIVERY WARNING"),
    );
    expect(
      frame
        .trimEnd()
        .endsWith("Nothing was hidden; all 1 finding is shown above."),
    ).toBe(true);
  });

  it("replaces the live dashboard with the compact final report", () => {
    const view = render(
      <ScanApp
        events={events}
        elapsedMs={5}
        width={120}
        color={false}
        animations={false}
      />,
    );
    expect(view.lastFrame()).toContain("ACTIVITY");

    view.rerender(
      <ScanApp
        events={events}
        elapsedMs={15}
        width={120}
        color={false}
        animations={false}
        report={createReport()}
      />,
    );
    const finalFrame = view.lastFrame()!;

    expect(finalFrame).toContain("BEE-UTIFUL");
    expect(finalFrame).not.toContain("ACTIVITY");
    expect(finalFrame).not.toContain("PROGRESS");
  });

  it("renders per-finding hierarchy without file groups", () => {
    const finding = createFinding({
      check: "lint",
      rule: "no-unused-vars",
      sourceExcerpt: {
        line: 2,
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
    const frame = render(
      <ScanApp
        events={events}
        elapsedMs={15}
        width={120}
        color={false}
        animations={false}
        report={report}
      />,
    ).lastFrame()!;

    expect(frame.match(/src\/value\.ts/g)).toHaveLength(1);
    expect(frame).toContain("ESLint  no-unused-vars");
    expect(frame).toContain("2 │ const unused = calculateValue()");
    expect(frame).toContain(
      "Issue: Staged code does not match the managed format.",
    );
    expect(frame).toContain(
      "Fix: Format the staged lines, then stage the result.",
    );
  });

  it("renders a sanitized bidi-control source fixture in real Ink", () => {
    const [finding] = sanitizeCheckResult({
      checkId: "lint",
      status: "completed",
      durationMs: 1,
      findings: [
        createFinding({
          check: "lint",
          sourceExcerpt: {
            line: 2,
            text: "const BIDI_MARKER = 'before\u202eafter';",
            redacted: false,
            truncated: false,
          },
        }),
      ],
    }).findings;
    const report = createReport({
      outcome: "blocked",
      exitCode: 1,
      summary: {
        passed: 0,
        warnings: 0,
        failed: 1,
        incomplete: 0,
        findings: [finding!],
      },
    });

    const frame = render(
      <ScanApp
        events={events}
        elapsedMs={15}
        width={120}
        color={false}
        animations={false}
        report={report}
      />,
    ).lastFrame()!;

    expect(frame).toContain("BIDI_MARKER = 'before�after'");
    expect(frame).not.toContain("\u202e");
  });

  it("places incomplete diagnostics before retained findings", () => {
    const finding = createFinding({ check: "lint", rule: "no-unused-vars" });
    const cleanupPath = "/private/tmp/zedbee-snapshot-validated-123";
    const report = createReport({
      outcome: "incomplete",
      exitCode: 2,
      checks: [
        {
          checkId: "zedbee",
          status: "incomplete",
          durationMs: 4,
          findings: [],
          error: {
            code: "SNAPSHOT_CLEANUP_FAILED",
            message: "Zedbee could not remove its temporary snapshot.",
            temporaryPath: cleanupPath,
            remediation:
              "Remove the temporary directory manually, then scan again.",
          },
        },
      ],
      summary: {
        passed: 1,
        warnings: 0,
        failed: 1,
        incomplete: 1,
        findings: [finding],
      },
    });
    const frame = render(
      <ScanApp
        events={events}
        elapsedMs={15}
        width={96}
        color={false}
        animations={false}
        report={report}
      />,
    ).lastFrame()!;

    expect(frame).toContain("SCAN INCOMPLETE");
    expect(frame).toContain(cleanupPath);
    expect(frame).toContain(
      "Remove the temporary directory manually, then scan again.",
    );
    expect(frame.indexOf("INCOMPLETE CHECKS")).toBeLessThan(
      frame.indexOf("ESLint  no-unused-vars"),
    );
    expect(frame).not.toContain("1 incomplete");
    expect(frame).toContain("✕ Restore the incomplete check, then scan again.");
  });
});
