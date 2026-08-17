import type { CheckResult } from "../core/types.js";
import { findingCheckLabel } from "../reporting/check-label.js";
import { terminalCellWidth, wrapTerminalWords } from "./terminal-cells.js";

function wrapWords(value: string, width: number, prefix = ""): string[] {
  const available = Math.max(1, width - terminalCellWidth(prefix));
  return wrapTerminalWords(value, available).map((line) => `${prefix}${line}`);
}

function fieldLines(label: string, value: string, width: number): string[] {
  const prefix = `  ${label}: `;
  const prefixWidth = terminalCellWidth(prefix);
  const continuation = " ".repeat(prefixWidth);
  return wrapWords(value, Math.max(1, width - prefixWidth)).map(
    (line, index) => `${index === 0 ? prefix : continuation}${line}`,
  );
}

function titleLines(check: CheckResult, width: number): string[] {
  const title =
    check.error?.code.replaceAll("_", " ") ??
    `${findingCheckLabel(check.checkId).toUpperCase()} INCOMPLETE`;
  return wrapWords(title, width);
}

export function incompleteDiagnosticLines(
  check: CheckResult,
  width: number,
): string[] {
  if (check.status !== "incomplete") return [];
  const error = check.error;
  const lines = titleLines(check, width);
  if (error === undefined) return lines;
  lines.push(...fieldLines("Issue", error.message, width));
  if (error.path !== undefined) {
    lines.push(...fieldLines("Path", error.path, width));
  }
  if (error.temporaryPath !== undefined) {
    lines.push(...fieldLines("Cleanup", error.temporaryPath, width));
  }
  if (error.remediation !== undefined) {
    lines.push(...fieldLines("Fix", error.remediation, width));
  }
  return lines;
}

export function incompleteSectionLines(
  checks: readonly CheckResult[],
  width: number,
): string[] {
  const incomplete = checks.filter((check) => check.status === "incomplete");
  if (incomplete.length === 0) return [];
  return [
    "",
    "INCOMPLETE CHECKS",
    ...incomplete.flatMap((check, index) => [
      ...(index === 0 ? [] : [""]),
      ...incompleteDiagnosticLines(check, width),
    ]),
  ];
}
