import type { Finding } from "../core/types.js";
import type { ScanReport } from "../scan/report.js";
import { validateReportDisplayStrings } from "../checks/sanitize-result.js";
import { compareCodeUnits } from "../core/compare.js";
import { findingCheckLabel } from "../reporting/check-label.js";
import { incompleteSectionLines } from "./incomplete.js";

export interface TextRendererOptions {
  width: number;
  color: boolean;
  verbose?: boolean;
}

function visibleLength(value: string): number {
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

function wrapWords(value: string, width: number, indent = ""): string[] {
  const available = Math.max(1, width - visibleLength(indent));
  const words = value.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words.flatMap((item) => chunks(item, available))) {
    if (current === "") {
      current = word;
    } else if (visibleLength(current) + 1 + visibleLength(word) <= available) {
      current += ` ${word}`;
    } else {
      lines.push(`${indent}${current}`);
      current = word;
    }
  }
  if (current !== "" || lines.length === 0) lines.push(`${indent}${current}`);
  return lines;
}

function descriptionLines(
  label: "Issue" | "Fix" | "Attribution",
  value: string,
  width: number,
): string[] {
  const indent = label === "Attribution" ? "    " : "       ";
  const prefix = `${indent}${label}: `;
  const continuation = " ".repeat(visibleLength(prefix));
  return wrapWords(value, Math.max(1, width - visibleLength(prefix))).map(
    (line, index) => `${index === 0 ? prefix : continuation}${line}`,
  );
}

function truncateLine(value: string, width: number): string {
  const points = Array.from(value);
  if (points.length <= width) return value;
  if (width === 1) return "…";
  return `${points.slice(0, width - 1).join("")}…`;
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
  if (location === undefined) return chunks(left, width);
  const right = `${location.file}:${location.startLine ?? 1}`;
  const gap = width - visibleLength(left) - visibleLength(right);
  if (gap >= 8) return [`${left}${" ".repeat(gap)}${right}`];
  return [
    ...chunks(left, width),
    ...chunks(right, width).map((line) => line.padStart(width)),
  ];
}

function sourceLine(finding: Finding, width: number): string | undefined {
  const excerpt = finding.sourceExcerpt;
  if (excerpt === undefined) return undefined;
  const text = excerpt.redacted ? "[redacted]" : (excerpt.text ?? "");
  const suffix = excerpt.truncated && !excerpt.redacted ? "…" : "";
  return truncateLine(
    `${String(excerpt.line).padStart(4)} │ ${text}${suffix}`,
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
