import type { ScanReport } from "../scan/report.js";
import { emptyChangesCopy } from "./source-identity.js";

export function checkCoverage(
  report: ScanReport,
): Readonly<{ completed: number; skipped: number; incomplete: number }> {
  return {
    completed: report.checks.filter((check) => check.status === "completed")
      .length,
    skipped: report.checks.filter((check) => check.status === "skipped").length,
    incomplete: report.checks.filter((check) => check.status === "incomplete")
      .length,
  };
}
export function coverageLine(report: ScanReport): string {
  const { completed, skipped, incomplete } = checkCoverage(report);
  return `${completed} ${completed === 1 ? "check" : "checks"} run · ${skipped} skipped · ${incomplete} incomplete`;
}
export function allowedScanDetail(report: ScanReport): string {
  if (report.changedFileCount === 0) return emptyChangesCopy(report);
  const coverage = checkCoverage(report);
  if (
    report.summary.warnings > 0 ||
    report.summary.incomplete > 0 ||
    coverage.incomplete > 0
  ) {
    const concerns = [
      ...(report.summary.warnings > 0 ? ["warnings"] : []),
      ...(report.summary.incomplete > 0 || coverage.incomplete > 0
        ? ["incomplete checks"]
        : []),
    ];
    return `Commit allowed. Review ${concerns.join(" and ")}.`;
  }
  if (coverage.completed === 0) {
    if (coverage.skipped === 0)
      return "No checks ran for the selected changes. Commit allowed.";
    const scope =
      report.mode === "base" ? "selected committed changes" : "staged changes";
    return `No applicable checks for the ${scope}. Commit allowed.`;
  }
  return "All checks passed. Commit allowed.";
}

export function scanOutcomeDetail(report: ScanReport): string {
  if (report.outcome === "blocked") return "A check failed. Commit blocked.";
  if (report.outcome === "incomplete")
    return "A required check could not finish. Commit blocked.";
  return allowedScanDetail(report);
}

export function scanResultCountLine(
  report: ScanReport,
  includeFailed: boolean,
): string {
  const { passed, warnings, failed } = report.summary;
  return `${passed} passed · ${warnings} ${warnings === 1 ? "warning" : "warnings"}${includeFailed ? ` · ${failed} failed` : ""}`;
}
