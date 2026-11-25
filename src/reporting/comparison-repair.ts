import type { Finding } from "../core/types.js";
import type { ScanReport } from "../scan/report.js";
import type { ScanMode } from "../scan/source-mode.js";

/** Managed fix commands operate on the index, never a committed comparison. */
export function repairFindingForMode(
  finding: Finding,
  mode?: ScanMode,
): Finding {
  if (mode !== "base" || finding.automaticFix === undefined) return finding;
  const { automaticFix: _automaticFix, ...result } = finding;
  return {
    ...result,
    remediation:
      "Correct the committed change, commit the fix, and rerun Zedbee over the same base range.",
  };
}

export function reportForComparisonRepairs(report: ScanReport): ScanReport {
  if (report.mode !== "base") return report;
  return {
    ...report,
    summary: {
      ...report.summary,
      findings: report.summary.findings.map((finding) =>
        repairFindingForMode(finding, report.mode),
      ),
    },
    checks: report.checks.map((check) => ({
      ...check,
      findings: check.findings.map((finding) =>
        repairFindingForMode(finding, report.mode),
      ),
    })),
  };
}
