import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { terminalCellWidth } from "../../src/renderers/terminal-cells.js";
import { renderText } from "../../src/renderers/text.js";
import type { TerminalPresentation } from "../../src/reporting/presentation.js";
import { ScanResultDashboard } from "../../src/ui/scan-result-dashboard.js";
import { createReport } from "../helpers/scan-report.js";

const scopedTarget = "workspace-for-international-storefront-integration-tests";
const report = createReport({
  checks: [
    { checkId: "secrets", status: "completed", durationMs: 1, findings: [] },
    {
      checkId: "lint",
      target: scopedTarget,
      status: "skipped",
      durationMs: 0,
      findings: [],
      skipReason:
        "Workspace compiler inputs are independent of the selected changes",
    },
    ...["reactCorrectness", "reactAccessibility"].map((checkId) => ({
      checkId,
      status: "skipped" as const,
      durationMs: 0,
      findings: [],
      skipReason: "No supported changed source files",
    })),
  ],
});
const presentation: TerminalPresentation = {
  automatic: true,
  reportStatus: "not-requested",
  findings: [],
  totalFindingCount: 0,
  abbreviated: false,
  warnings: [],
};

describe.each([40, 80])("%i-column skip coverage", (width) => {
  it("names checks and groups identical reasons in plain and branded output", () => {
    const dashboard = render(
      <ScanResultDashboard
        report={report}
        presentation={presentation}
        width={width}
        color={false}
      />,
    ).lastFrame()!;
    for (const output of [
      renderText(report, { width, color: false, presentation }),
      renderText(report, { width, color: false }),
      dashboard,
    ]) {
      const words = output.replace(/[│█]/gu, " ").replace(/\s+/gu, " ");
      expect(words).toContain("SKIPPED CHECKS");
      expect(words).toContain("React correctness");
      expect(words).toContain("React accessibility");
      expect(words).toContain("Lint");
      expect(output.match(/No supported/g)).toHaveLength(1);
      expect(words).toContain("1 check run");
      expect(words).toContain("3 skipped");
      for (const line of output.split("\n")) {
        expect(terminalCellWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
