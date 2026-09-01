import { displayLabel } from "../core/display-text.js";
import type { ScanReport } from "../scan/report.js";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export function scanSourceIdentityLine(report: ScanReport): string | undefined {
  if (
    report.mode !== "base" ||
    typeof report.baseline !== "string" ||
    typeof report.target !== "string" ||
    !OBJECT_ID.test(report.baseline) ||
    !OBJECT_ID.test(report.target) ||
    report.requestedBase === undefined
  ) {
    return undefined;
  }

  let requestedBase: string;
  try {
    requestedBase = displayLabel(report.requestedBase, "requested base");
  } catch {
    return undefined;
  }

  return `Committed changes · base ${requestedBase} · ${report.baseline.slice(0, 12)}..${report.target.slice(0, 12)}`;
}

export function emptyChangesCopy(report: ScanReport): string {
  return report.mode === "base"
    ? "No committed changes. Commit allowed."
    : "No staged changes. Commit allowed.";
}
