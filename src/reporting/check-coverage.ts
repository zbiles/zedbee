import type { CheckResult, Finding } from "../core/types.js";
import { validateReportDisplayStrings } from "../checks/sanitize-result.js";
import {
  chunkTerminalCells,
  wrapTerminalWords,
} from "../renderers/terminal-cells.js";
import { comparePreviewFindings } from "./finding-priority.js";
import { checkLabel } from "./check-label.js";
import type { ScanReport } from "../scan/report.js";
import { changedScopeLabel, emptyChangesCopy } from "./source-identity.js";

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
export function skippedCheckSummaries(
  checks: readonly CheckResult[],
): readonly string[] {
  const groups = new Map<string, Set<string>>();
  for (const check of checks) {
    if (check.status !== "skipped") continue;
    const reason = check.skipReason ?? "Not applicable";
    const label = checkLabel(check.checkId);
    const name =
      check.target === undefined || check.target === "."
        ? label
        : `${label} (${check.target})`;
    let checksForReason = groups.get(reason);
    if (checksForReason === undefined) {
      checksForReason = new Set();
      groups.set(reason, checksForReason);
    }
    checksForReason.add(name);
  }
  return [...groups].map(
    ([reason, names]) => `${reason} — ${[...names].join(", ")}`,
  );
}

export function allowedScanDetail(report: ScanReport): string {
  if (report.changedFileCount === 0) return emptyChangesCopy(report);
  const verdict = report.mode === "base" ? "Scan passed." : "Commit allowed.";
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
    return `${verdict} Review ${concerns.join(" and ")}.`;
  }
  if (coverage.completed === 0) {
    if (coverage.skipped === 0)
      return `No checks ran for the selected changes. ${verdict}`;
    return `No applicable checks for the ${changedScopeLabel(report.mode)}. ${verdict}`;
  }
  return `All checks passed. ${verdict}`;
}

export function scanOutcomeHeading(report: ScanReport): string {
  if (report.outcome === "incomplete") return "SCAN INCOMPLETE";
  if (report.outcome === "blocked")
    return report.mode === "base" ? "SCAN BLOCKED" : "COMMIT BLOCKED";
  return report.mode === "base" ? "SCAN PASSED" : "COMMIT ALLOWED";
}

export function scanOutcomeDetail(
  report: ScanReport,
  detailed = false,
): string {
  const blocked = report.mode === "base" ? "Scan blocked." : "Commit blocked.";
  if (report.outcome === "blocked")
    return report.mode === "base"
      ? "Blocking findings in selected commits."
      : `A check failed. ${blocked}`;
  if (report.outcome === "incomplete") {
    const guidance = detailed
      ? " Review INCOMPLETE CHECKS above for details."
      : "";
    return `A required check could not finish.${guidance} ${report.mode === "base" ? "Scan incomplete." : blocked}`;
  }
  return allowedScanDetail(report);
}

/** Identify the first visible blocker without repeating its diagnostic prose. */
export function blockedFindingLines(
  report: ScanReport,
  visibleFindings: readonly Finding[],
  width: number,
): readonly string[] {
  if (report.outcome !== "blocked") return [];

  const first = visibleFindings
    .filter(({ severity }) => severity === "error")
    .sort(comparePreviewFindings)[0];
  if (first === undefined) return [];

  const [finding] = validateReportDisplayStrings({
    checks: [],
    summary: { findings: [first] },
  }).summaryFindings;
  if (finding === undefined) return [];

  const lines = wrapTerminalWords(
    `${checkLabel(finding.check)} · ${finding.rule}`,
    width,
  );
  if (finding.location !== undefined) {
    const { file, startLine, startColumn } = finding.location;
    const line = startLine === undefined ? "" : `:${startLine}`;
    const column =
      startLine === undefined || startColumn === undefined
        ? ""
        : `:${startColumn}`;
    lines.push(...chunkTerminalCells(`${file}${line}${column}`, width));
  }
  const remaining = report.summary.failed - 1;
  if (remaining > 0) {
    const label = remaining === 1 ? "finding" : "findings";
    lines.push(
      ...wrapTerminalWords(
        `${remaining} more blocking ${label}. See the detailed findings.`,
        width,
      ),
    );
  }
  return lines;
}

export function scanResultCountLine(
  report: ScanReport,
  includeFailed: boolean,
): string {
  const { passed, warnings, failed } = report.summary;
  return `${passed} passed · ${warnings} ${warnings === 1 ? "warning" : "warnings"}${includeFailed ? ` · ${failed} failed` : ""}`;
}
