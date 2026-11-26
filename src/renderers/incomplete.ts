import type { CheckResult, StructuralParseFailures } from "../core/types.js";
import { findingCheckLabel } from "../reporting/check-label.js";
import {
  terminalCellWidth,
  wrapPrefixedTerminalWords as wrapWords,
} from "./terminal-cells.js";

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

export function parseFailureFields(
  failures: StructuralParseFailures,
): readonly {
  label: string;
  value: string;
}[] {
  const fields = failures.files.slice(0, 10).map((file) => ({
    label:
      file.snapshot === "staged"
        ? "Staged"
        : file.snapshot === "baseline"
          ? "Baseline"
          : "Target",
    value: `${file.path}:${file.line}:${file.column} · ${file.reason}`,
  }));
  if (failures.files.length > 10) {
    fields.push({
      label: "More",
      value: `${failures.files.length - 10} more. Use --format json for all recorded failures.`,
    });
  }
  if (failures.omitted > 0) {
    fields.push({
      label: "Limit",
      value: `${failures.omitted} additional parse failures exceeded the report limit.`,
    });
  }
  return fields;
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
  if (error.path !== undefined && error.parseFailures === undefined) {
    lines.push(...fieldLines("Path", error.path, width));
  }
  if (error.snapshot !== undefined) {
    lines.push(
      ...fieldLines(
        "Checked version",
        error.snapshot === "last-commit" ? "Previous commit" : "Staged files",
        width,
      ),
    );
  }
  if (error.projectPaths !== undefined) {
    const label =
      error.projectPaths.length === 1 ? "Loaded project" : "Loaded projects";
    lines.push(...fieldLines(label, error.projectPaths.join(", "), width));
  }
  if (error.parseFailures !== undefined) {
    for (const { label, value } of parseFailureFields(error.parseFailures))
      lines.push(...fieldLines(label, value, width));
  } else if (error.paths !== undefined) {
    lines.push(
      ...fieldLines("Affected files", String(error.paths.length), width),
    );
    for (const path of error.paths.slice(0, 10)) {
      lines.push(...fieldLines("File", path, width));
    }
    if (error.paths.length > 10) {
      lines.push(
        ...fieldLines("More files", String(error.paths.length - 10), width),
      );
    }
  }
  if (error.temporaryPath !== undefined) {
    lines.push(...fieldLines("Cleanup", error.temporaryPath, width));
  }
  if (error.remediation !== undefined) {
    lines.push(...fieldLines("Fix", error.remediation, width));
  }
  if (check.incompleteDisposition !== undefined) {
    const action =
      check.incompleteDisposition === "block"
        ? "commit blocked"
        : "commit allowed";
    lines.push(
      ...fieldLines(
        "Availability",
        `${action} (onUnavailable: ${check.incompleteDisposition})`,
        width,
      ),
    );
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
