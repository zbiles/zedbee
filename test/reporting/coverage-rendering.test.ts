import { expect, it } from "vitest";
import { renderText } from "../../src/renderers/text.js";
import { createReport } from "../helpers/scan-report.js";
it("explains skips in explicitly requested verbose text", () => {
  const report = createReport({
    checks: [
      {
        checkId: "types",
        status: "skipped",
        durationMs: 0,
        findings: [],
        skipReason: "No supported changed TypeScript source files",
      },
    ],
  });
  expect(
    renderText(report, { width: 120, color: false, verbose: true }),
  ).toContain("types: skipped — No supported changed TypeScript source files");
});
it.each([40, 80, 120])(
  "adapts saved generated guidance in automatic text at %i columns",
  async (width) => {
    const { RECOMMENDED_AGENT_GUIDANCE } =
      await import("../../src/reporting/agent-guidance.js");
    const report = createReport();
    const withGuidance = {
      ...report,
      presentationPolicy: {
        ...report.presentationPolicy,
        agentGuidance: RECOMMENDED_AGENT_GUIDANCE,
      },
    };
    const output = renderText(withGuidance, {
      width,
      color: false,
      presentation: {
        automatic: true,
        reportStatus: "available",
        reportPath: "/private/tmp/zedbee-reports/complete.json",
        findings: [],
        totalFindingCount: 0,
        abbreviated: false,
        warnings: [],
      },
    });
    expect(output).not.toContain("Fix every blocking finding");
    expect(output.replace(/\s+/g, " ")).toContain(
      "No findings require action.",
    );
    expect(output).toMatch(/action\.\n\nCOMPLETE REPORT/);
  },
);
