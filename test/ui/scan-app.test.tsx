import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ScanEvent } from "../../src/checks/events.js";
import { ScanApp } from "../../src/ui/scan-app.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

const events: ScanEvent[] = [
  { type: "check-queued", checkId: "formatting", target: ".", timestamp: 1 },
  { type: "check-running", checkId: "formatting", target: ".", timestamp: 2 },
];

describe("ScanApp", () => {
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
