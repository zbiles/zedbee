import type { ScanReport } from "../scan/report.js";
import { sanitizeScanSourceIdentity } from "../scan/source-mode.js";

export function scanSourceIdentityLine(report: ScanReport): string | undefined {
  const source = sanitizeScanSourceIdentity(report);
  if (source.mergeParents !== undefined)
    return `Staged merge · parents ${source.mergeParents.map((parent) => parent.slice(0, 12)).join(" + ")}`;
  if (source.mode !== "base" || source.requestedBase === undefined) {
    return undefined;
  }
  if (source.baseline === null || source.target === null) {
    return `Committed changes · base ${source.requestedBase} · unresolved`;
  }
  return `Committed changes · base ${source.requestedBase} · ${source.baseline.slice(0, 12)}..${source.target.slice(0, 12)}`;
}

export function emptyChangesCopy(report: ScanReport): string {
  return report.mode === "base"
    ? "No committed changes. Commit allowed."
    : "No staged changes. Commit allowed.";
}

export function selectedChangesLine(report: ScanReport): string | undefined {
  if (report.changeSummary === undefined || report.mergeParents !== undefined)
    return undefined;
  const { added, modified, deleted, renamed } = report.changeSummary;
  return `${report.mode === "base" ? "Committed" : "Staged"} changes: ${added} added · ${modified} modified · ${deleted} deleted · ${renamed} renamed`;
}
