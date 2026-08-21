import type { CheckResult, Finding } from "../core/types.js";
import type { ScanReport } from "../scan/report.js";
import type { TerminalPresentation } from "./presentation.js";
import type { ReportMaintenanceWarning } from "./temporary-reports.js";

export interface ScanResultSections {
  readonly blockingFindings: readonly Finding[];
  readonly warningFindings: readonly Finding[];
  readonly disclosures: ScanReport["networkDisclosures"];
  readonly incompleteChecks: readonly CheckResult[];
  readonly reportWarnings: readonly ReportMaintenanceWarning[];
}

export function buildScanResultSections(
  report: ScanReport,
  presentation: TerminalPresentation,
): ScanResultSections {
  return Object.freeze({
    blockingFindings: Object.freeze(
      presentation.findings.filter(({ severity }) => severity === "error"),
    ),
    warningFindings: Object.freeze(
      presentation.findings.filter(({ severity }) => severity !== "error"),
    ),
    disclosures: Object.freeze([...report.networkDisclosures]),
    incompleteChecks: Object.freeze(
      report.checks.filter(({ status }) => status === "incomplete"),
    ),
    reportWarnings: Object.freeze([...presentation.warnings]),
  });
}
