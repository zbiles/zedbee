import type { Finding } from "../core/types.js";
import type { ScanReport } from "../scan/report.js";
import { validateReportDisplayStrings } from "../checks/sanitize-result.js";
import { compareCodeUnits } from "../core/compare.js";
import { findingCheckLabel } from "../reporting/check-label.js";
import { incompleteSectionLines } from "./incomplete.js";
import {
  chunkTerminalCells,
  padStartTerminalCells,
  terminalCellWidth,
  truncateTerminalCells,
  wrapTerminalWords,
} from "./terminal-cells.js";

export interface TextRendererOptions {
  width: number;
  color: boolean;
  verbose?: boolean;
}

function wrapWords(value: string, width: number, indent = ""): string[] {
  const available = Math.max(1, width - terminalCellWidth(indent));
  return wrapTerminalWords(value, available).map((line) => `${indent}${line}`);
}

function descriptionLines(
  label: "Issue" | "Fix" | "Attribution",
  value: string,
  width: number,
): string[] {
  const indent = label === "Attribution" ? "    " : "       ";
  const prefix = `${indent}${label}: `;
  const prefixWidth = terminalCellWidth(prefix);
  const continuation = " ".repeat(prefixWidth);
  return wrapWords(value, Math.max(1, width - prefixWidth)).map(
    (line, index) => `${index === 0 ? prefix : continuation}${line}`,
  );
}

function countLine(report: ScanReport): string {
  const { passed, warnings, failed } = report.summary;
  const warningLabel = warnings === 1 ? "warning" : "warnings";
  if (report.outcome === "blocked") {
    return `${passed} passed · ${warnings} ${warningLabel} · ${failed} failed`;
  }
  if (report.outcome === "incomplete") {
    return `${passed} passed · ${warnings} ${warningLabel} · ${failed} failed`;
  }
  return `${passed} passed · ${warnings} ${warningLabel}`;
}

function headline(report: ScanReport): string[] {
  if (report.outcome === "blocked") {
    return [
      "THAT STINGS",
      "A check failed. Commit blocked.",
      countLine(report),
    ];
  }
  if (report.outcome === "incomplete") {
    return [
      "SCAN INCOMPLETE",
      "A required check could not finish. Commit blocked.",
      countLine(report),
    ];
  }
  return [
    "BEE-UTIFUL",
    report.stagedFileCount === 0
      ? "No staged changes. Commit allowed."
      : "All checks passed. Commit allowed.",
    countLine(report),
  ];
}

function findingHeader(finding: Finding, width: number): string[] {
  const left = `${findingCheckLabel(finding.check)}  ${finding.rule}`;
  const location = finding.location;
  if (location === undefined) return chunkTerminalCells(left, width);
  const right = `${location.file}:${location.startLine ?? 1}`;
  const gap = width - terminalCellWidth(left) - terminalCellWidth(right);
  if (gap >= 8) return [`${left}${" ".repeat(gap)}${right}`];
  return [
    ...chunkTerminalCells(left, width),
    ...chunkTerminalCells(right, width).map((line) =>
      padStartTerminalCells(line, width),
    ),
  ];
}

function sourceLine(finding: Finding, width: number): string | undefined {
  const excerpt = finding.sourceExcerpt;
  if (excerpt === undefined) return undefined;
  const text = excerpt.redacted ? "[redacted]" : (excerpt.text ?? "");
  return truncateTerminalCells(
    `${String(excerpt.line).padStart(4)} │ ${text}`,
    width,
  );
}

function findingLines(
  finding: Finding,
  width: number,
  verbose: boolean,
): string[] {
  const source = sourceLine(finding, width);
  const lines = [
    ...findingHeader(finding, width),
    ...(source === undefined ? [] : [source]),
    ...descriptionLines("Issue", finding.message, width),
  ];
  if (finding.remediation !== undefined) {
    lines.push(...descriptionLines("Fix", finding.remediation, width));
  }
  if (verbose) {
    const evidence = [...finding.attribution.evidence].sort(compareCodeUnits);
    lines.push(
      ...descriptionLines(
        "Attribution",
        `${finding.attribution.kind}${
          evidence.length === 0 ? "" : ` · ${evidence.join(" · ")}`
        }`,
        width,
      ),
    );
  }
  return lines;
}

function renderedFindings(
  findings: readonly Finding[],
  width: number,
  verbose: boolean,
): string[] {
  return findings.flatMap((finding) => [
    "",
    ...findingLines(finding, width, verbose),
  ]);
}

function disclosureLines(report: ScanReport, width: number): string[] {
  if (report.networkDisclosures.length === 0) return [];
  return [
    "",
    "NETWORK DISCLOSURE",
    ...report.networkDisclosures.flatMap((disclosure) =>
      wrapWords(
        `${disclosure.checkId} sent ${disclosure.metadata.join(", ")} to ${disclosure.services.join(", ")}.`,
        width,
        "  ",
      ),
    ),
  ];
}

export function renderText(
  report: ScanReport,
  options: TextRendererOptions,
): string {
  const sanitized = validateReportDisplayStrings(report);
  const width = Math.max(20, options.width);
  const lines = [
    ...headline(report).flatMap((line) => wrapWords(line, width)),
    ...incompleteSectionLines(sanitized.checks, width),
    ...renderedFindings(
      sanitized.summaryFindings,
      width,
      options.verbose === true,
    ),
    ...disclosureLines(report, width),
  ];
  return `${lines.join("\n")}\n`;
}
