import { describe, expect, it } from "vitest";
import { buildScanResultSections } from "../../src/reporting/result-sections.js";
import type { TerminalPresentation } from "../../src/reporting/presentation.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

function automaticPresentation(
  findings: TerminalPresentation["findings"],
): TerminalPresentation {
  return {
    automatic: true,
    reportStatus: "available",
    findings,
    totalFindingCount: 4,
    abbreviated: true,
    reportPath: "/private/tmp/zedbee-reports/report.json",
    maximumAge: "24h",
    warnings: [
      {
        code: "TEMP_REPORT_CLEANUP_FAILED",
        message: "An older report could not be removed.",
      },
    ],
  };
}

describe("buildScanResultSections", () => {
  it("uses the already-selected combined preview while retaining every non-finding section", () => {
    const firstWarning = createFinding({
      id: "warning-one",
      severity: "warning",
      rule: "warning-one",
    });
    const blocking = createFinding({ id: "blocking", rule: "blocking" });
    const secondWarning = createFinding({
      id: "warning-two",
      severity: "warning",
      rule: "warning-two",
    });
    const hiddenBlocking = createFinding({
      id: "hidden-blocking",
      rule: "hidden-blocking",
    });
    const report = createReport({
      summary: {
        passed: 1,
        warnings: 2,
        failed: 2,
        incomplete: 1,
        findings: [firstWarning, blocking, secondWarning, hiddenBlocking],
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
          checkId: "formatting",
          status: "completed",
          durationMs: 1,
          findings: [],
        },
        {
          checkId: "vulnerabilities",
          status: "incomplete",
          incompleteDisposition: "block",
          durationMs: 2,
          findings: [],
          error: {
            code: "OSV_UNAVAILABLE",
            message: "OSV is unavailable.",
          },
        },
      ],
    });

    const sections = buildScanResultSections(
      report,
      automaticPresentation([blocking, firstWarning, secondWarning]),
    );

    expect(sections.blockingFindings.map(({ id }) => id)).toEqual(["blocking"]);
    expect(sections.warningFindings.map(({ id }) => id)).toEqual([
      "warning-one",
      "warning-two",
    ]);
    expect(sections.disclosures).toEqual(report.networkDisclosures);
    expect(sections.incompleteChecks).toEqual([report.checks[1]]);
    expect(sections.reportWarnings).toEqual([
      {
        code: "TEMP_REPORT_CLEANUP_FAILED",
        message: "An older report could not be removed.",
      },
    ]);
    expect(sections.blockingFindings.map(({ id }) => id)).not.toContain(
      "hidden-blocking",
    );
  });

  it("represents absent renderer panels as empty arrays", () => {
    const report = createReport();
    const sections = buildScanResultSections(report, automaticPresentation([]));

    expect(sections.blockingFindings).toEqual([]);
    expect(sections.warningFindings).toEqual([]);
    expect(sections.disclosures).toEqual([]);
    expect(sections.incompleteChecks).toEqual([]);
    expect(sections.reportWarnings).toEqual([
      {
        code: "TEMP_REPORT_CLEANUP_FAILED",
        message: "An older report could not be removed.",
      },
    ]);
  });
});
