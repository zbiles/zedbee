import type { CheckResult } from "../core/types.js";
import { findingCheckLabel } from "../reporting/check-label.js";

function length(value: string): number {
  return Array.from(value).length;
}

function chunks(value: string, width: number): string[] {
  const points = Array.from(value);
  const lines: string[] = [];
  for (let index = 0; index < points.length; index += width) {
    lines.push(points.slice(index, index + width).join(""));
  }
  return lines.length === 0 ? [""] : lines;
}

function wrapWords(value: string, width: number, prefix = ""): string[] {
  const available = Math.max(1, width - length(prefix));
  const words = value.trim().split(/\s+/u).filter(Boolean);
  const content: string[] = [];
  let current = "";
  for (const word of words.flatMap((item) => chunks(item, available))) {
    if (current === "") {
      current = word;
    } else if (length(current) + 1 + length(word) <= available) {
      current += ` ${word}`;
    } else {
      content.push(current);
      current = word;
    }
  }
  if (current !== "" || content.length === 0) content.push(current);
  return content.map((line) => `${prefix}${line}`);
}

function fieldLines(label: string, value: string, width: number): string[] {
  const prefix = `  ${label}: `;
  const continuation = " ".repeat(length(prefix));
  return wrapWords(value, Math.max(1, width - length(prefix))).map(
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
