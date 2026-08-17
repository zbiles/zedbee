import type { Finding } from "../core/types.js";
import type { ScanReport } from "../scan/report.js";
import { validateReportDisplayStrings } from "../checks/sanitize-result.js";
import { compareCodeUnits } from "../core/compare.js";

export interface TextRendererOptions {
  width: number;
  color: boolean;
  verbose?: boolean;
}

function wrapWords(value: string, width: number, indent: string): string[] {
  const available = Math.max(1, width - indent.length);
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= available) {
      current += ` ${word}`;
    } else {
      lines.push(`${indent}${current}`);
      current = word;
    }
  }
  if (current !== "") {
    lines.push(`${indent}${current}`);
  }
  return lines;
}

function countLine(report: ScanReport): string {
  const { passed, warnings, failed } = report.summary;
  const warningLabel = warnings === 1 ? "warning" : "warnings";
  if (report.outcome === "blocked") {
    return `${passed} passed · ${warnings} ${warningLabel} · ${failed} failed`;
  }
  if (report.outcome === "incomplete") {
    return `${passed} passed · ${warnings} ${warningLabel} · ${failed} failed · ${report.summary.incomplete} incomplete`;
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

function findingLines(
  finding: Finding,
  width: number,
  verbose: boolean,
): string[] {
  const location = finding.location;
  const line = location?.startLine ?? 1;
  const column = location?.startColumn ?? 1;
  const lines = [
    `  ${line}:${column}  ${finding.severity.toUpperCase()}  ${finding.check}/${finding.rule}`,
    ...wrapWords(finding.message, width, "    "),
  ];
  if (finding.remediation !== undefined) {
    lines.push(...wrapWords(`Fix: ${finding.remediation}`, width, "    "));
  }
  if (verbose) {
    const evidence = [...finding.attribution.evidence].sort(compareCodeUnits);
    lines.push(
      ...wrapWords(
        `Attribution: ${finding.attribution.kind}${
          evidence.length === 0 ? "" : ` · ${evidence.join(" · ")}`
        }`,
        width,
        "    ",
      ),
    );
  }
  return lines;
}

function groupedFindings(
  findings: readonly Finding[],
  width: number,
  verbose: boolean,
): string[] {
  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const file = finding.location?.file ?? "Repository";
    const group = byFile.get(file) ?? [];
    group.push(finding);
    byFile.set(file, group);
  }

  const lines: string[] = [];
  for (const [file, group] of byFile) {
    lines.push("", file.slice(0, width));
    for (const finding of group) {
      lines.push(...findingLines(finding, width, verbose));
    }
  }
  return lines;
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
    ...headline(report),
    ...groupedFindings(
      sanitized.summaryFindings,
      width,
      options.verbose === true,
    ),
    ...disclosureLines(report, width),
  ];
  return `${lines.join("\n")}\n`;
}
