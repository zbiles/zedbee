import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ScanEvent } from "../../src/checks/events.js";
import { ScanApp } from "../../src/ui/scan-app.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

const events: ScanEvent[] = [
  { type: "check-queued", checkId: "formatting", target: ".", timestamp: 1 },
  { type: "check-running", checkId: "formatting", target: ".", timestamp: 2 }
];

describe("ScanApp", () => {
  it("replaces the live dashboard with the compact final report", () => {
    const view = render(
      <ScanApp events={events} elapsedMs={5} width={120} color={false} animations={false} />
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
      />
    );
    const finalFrame = view.lastFrame()!;

    expect(finalFrame).toContain("BEE-UTIFUL");
    expect(finalFrame).not.toContain("ACTIVITY");
    expect(finalFrame).not.toContain("PROGRESS");
  });

  it("groups final findings by file and includes remediation", () => {
    const finding = createFinding();
    const report = createReport({
      outcome: "blocked",
      exitCode: 1,
      summary: {
        passed: 0,
        warnings: 0,
        failed: 1,
        incomplete: 0,
        findings: [finding]
      }
    });
    const frame = render(
      <ScanApp
        events={events}
        elapsedMs={15}
        width={120}
        color={false}
        animations={false}
        report={report}
      />
    ).lastFrame()!;

    expect(frame.match(/src\/value\.ts/g)).toHaveLength(1);
    expect(frame).toContain("formatting/prettier");
    expect(frame).toContain("Fix: Format the staged lines, then stage the result.");
  });
});
