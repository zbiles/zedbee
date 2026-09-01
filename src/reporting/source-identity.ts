import type { ScanReport } from "../scan/report.js";
import { sanitizeScanSourceIdentity } from "../scan/source-mode.js";

export function scanSourceIdentityLine(report: ScanReport): string | undefined {
  const source = sanitizeScanSourceIdentity(report);
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
