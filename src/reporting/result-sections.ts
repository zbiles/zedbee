import type {
  CheckResult,
  Finding,
  ManagedAutomaticFix,
} from "../core/types.js";
import { compareCodeUnits } from "../core/compare.js";
import type { ScanReport } from "../scan/report.js";
import type { TerminalPresentation } from "./presentation.js";
import type { ReportMaintenanceWarning } from "./temporary-reports.js";

export interface ScanResultSections {
  readonly blockingFindings: readonly Finding[];
  readonly warningFindings: readonly Finding[];
  readonly disclosures: ScanReport["networkDisclosures"];
  readonly incompleteChecks: readonly CheckResult[];
  readonly reportWarnings: readonly ReportMaintenanceWarning[];
  readonly automaticFixes: readonly ManagedAutomaticFix[];
}

function automaticFixes(
  report: ScanReport,
  presentation: TerminalPresentation,
): readonly ManagedAutomaticFix[] {
  const unique = new Map<string, ManagedAutomaticFix>();
  for (const finding of [
    ...presentation.findings,
    ...report.summary.findings,
  ]) {
    const automaticFix = finding.automaticFix;
    if (automaticFix === undefined) continue;
    unique.set(automaticFix.command.join("\u0000"), automaticFix);
  }
  return Object.freeze(
    [...unique.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, automaticFix]) => automaticFix),
  );
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
    automaticFixes: automaticFixes(report, presentation),
  });
}
