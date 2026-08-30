import type { Finding, ManagedAutomaticFix } from "../core/types.js";
import { CHECK_IDS } from "../config/schema.js";
import type { ScanReport } from "../scan/report.js";
import { validateReportDisplayStrings } from "../checks/sanitize-result.js";
import { compareCodeUnits } from "../core/compare.js";
import { findingCheckLabel } from "../reporting/check-label.js";
import {
  managedFixGuidanceLines,
  nextStepsLines,
} from "../reporting/next-steps.js";
import { opaqueTemporaryReportPath } from "../reporting/report-path.js";
import {
  buildReportCallouts,
  type ReportCalloutLine,
} from "../reporting/report-callouts.js";
import { buildScanResultSections } from "../reporting/result-sections.js";
import type { TerminalPresentation } from "../reporting/presentation.js";
import type { ReportMaintenanceWarning } from "../reporting/temporary-reports.js";
import { incompleteSectionLines } from "./incomplete.js";
import { terminalText, type TerminalTextTone } from "./terminal-style.js";
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
  presentation?: TerminalPresentation;
}

const PRIMARY_TEXT_HEADINGS = new Set([
  "THAT STINGS",
  "SCAN INCOMPLETE",
  "BEE-UTIFUL",
  "COMMIT BLOCKED",
  "COMMIT ALLOWED",
  "BLOCKING FINDINGS",
  "WARNINGS",
  "NETWORK DISCLOSURE",
  "DISCLOSURES",
  "REPORT WARNINGS",
  "REPORT MAINTENANCE WARNING",
  "REPORT DELIVERY WARNING",
  "INCOMPLETE CHECKS",
  "SCAN RESULT",
  "NEXT STEP",
  "COMPLETE REPORT",
]);

const FINDING_TEXT_LABELS = new Set(
  [...CHECK_IDS, "zedbee"].map((checkId) => findingCheckLabel(checkId)),
);

function textLineTone(line: string): TerminalTextTone {
  const trimmed = line.trimStart();
  if (PRIMARY_TEXT_HEADINGS.has(line)) return "primary";
  if (/^(?:Fix|Reason|Remediation): /u.test(trimmed)) return "reason";
  if (
    !line.startsWith(" ") &&
    [...FINDING_TEXT_LABELS].some(
      (label) => line === label || line.startsWith(`${label}  `),
    )
  ) {
    return "primary";
  }
  return "secondary";
}

function styleTextLines(lines: readonly string[], color: boolean): string[] {
  if (!color) return [...lines];
  return lines.map((line) =>
    line.length === 0 ? line : terminalText(line, textLineTone(line), true),
  );
}

function wrapWords(value: string, width: number, indent = ""): string[] {
  const available = Math.max(1, width - terminalCellWidth(indent));
  return wrapTerminalWords(value, available).map((line) => `${indent}${line}`);
}

function descriptionLines(
  label: "Issue" | "Fix" | "Attribution" | "Path",
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

function opaquePathLines(
  label: "Path" | "Full report",
  path: string,
  width: number,
): string[] {
  const prefix = label === "Path" ? "       Path: " : "Full report: ";
  const prefixWidth = terminalCellWidth(prefix);
  const chunks = chunkTerminalCells(
    opaqueTemporaryReportPath(path),
    Math.max(1, width - prefixWidth),
  );
  return chunks.map((chunk, index) =>
    index === 0 ? `${prefix}${chunk}` : chunk,
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

function automaticCountLine(report: ScanReport): string {
  const { passed, warnings, failed } = report.summary;
  const checkLabel = passed === 1 ? "check" : "checks";
  const blockingLabel = failed === 1 ? "finding" : "findings";
  const warningLabel = warnings === 1 ? "finding" : "findings";
  return `${passed} ${checkLabel} passed · ${failed} blocking ${blockingLabel} · ${warnings} warning ${warningLabel}`;
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

function findingSectionLines(
  heading: "BLOCKING FINDINGS" | "WARNINGS",
  findings: readonly Finding[],
  width: number,
  verbose: boolean,
): string[] {
  if (findings.length === 0) return [];
  return ["", heading, ...renderedFindings(findings, width, verbose)];
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

function disclosureSectionLines(
  disclosures: ScanReport["networkDisclosures"],
  width: number,
): string[] {
  if (disclosures.length === 0) return [];
  return [
    "",
    "DISCLOSURES",
    ...disclosures.flatMap((disclosure) =>
      wrapWords(
        `${disclosure.checkId} sent ${disclosure.metadata.join(", ")} to ${disclosure.services.join(", ")}.`,
        width,
        "  ",
      ),
    ),
  ];
}

function maintenanceWarningLines(
  warnings: readonly ReportMaintenanceWarning[],
  width: number,
): string[] {
  if (warnings.length === 0) return [];
  return warnings.flatMap((warning) => [
    "",
    "REPORT MAINTENANCE WARNING",
    ...wrapWords(warning.code.replaceAll("_", " "), width),
    ...descriptionLines("Issue", warning.message, width),
    ...(warning.path === undefined
      ? []
      : opaquePathLines("Path", warning.path, width)),
  ]);
}

function reportWarningsSectionLines(
  warnings: readonly ReportMaintenanceWarning[],
  width: number,
): string[] {
  if (warnings.length === 0) return [];
  return [
    "",
    "REPORT WARNINGS",
    ...warnings.flatMap((warning, index) => [
      ...(index === 0 ? [] : [""]),
      ...wrapWords(warning.code.replaceAll("_", " "), width),
      ...descriptionLines("Issue", warning.message, width),
      ...(warning.path === undefined
        ? []
        : opaquePathLines("Path", warning.path, width)),
    ]),
  ];
}

function calloutLines(
  callouts: readonly ReportCalloutLine[],
  width: number,
  automaticFixes: readonly ManagedAutomaticFix[] = [],
): string[] {
  const managedFixes = managedFixGuidanceLines(automaticFixes);
  const hasCompleteReport = callouts.some(
    (line) => line.kind === "text" && line.value === "COMPLETE REPORT",
  );
  return [
    ...callouts.flatMap((line) => [
      ...(line.kind === "text" && line.value === "COMPLETE REPORT"
        ? managedFixes.flatMap((value) => wrapWords(value, width))
        : []),
      ...(line.kind === "text"
        ? wrapWords(line.value, width)
        : chunkTerminalCells(opaqueTemporaryReportPath(line.path), width)),
    ]),
    ...(hasCompleteReport
      ? []
      : managedFixes.flatMap((value) => wrapWords(value, width))),
  ];
}

function completeManagedFixLines(
  findings: readonly Finding[],
  width: number,
): string[] {
  const managedFixes = managedFixGuidanceLines(
    findings.flatMap((finding) =>
      finding.automaticFix === undefined ? [] : [finding.automaticFix],
    ),
  );
  return managedFixes.length === 0
    ? []
    : [
        "",
        "NEXT STEP",
        ...managedFixes.flatMap((line) => wrapWords(line, width)),
      ];
}

function automaticHeadline(
  report: ScanReport,
  presentation: TerminalPresentation,
): string[] {
  const previewLine = presentation.abbreviated
    ? [
        `Showing ${presentation.findings.length} of ${presentation.totalFindingCount} findings.`,
      ]
    : [];
  if (report.outcome === "blocked") {
    return [
      "COMMIT BLOCKED",
      "A check failed. Commit blocked.",
      automaticCountLine(report),
      ...previewLine,
    ];
  }
  if (report.outcome === "incomplete") {
    return [
      "SCAN INCOMPLETE",
      "A required check could not finish. Review INCOMPLETE CHECKS above for details. Commit blocked.",
      automaticCountLine(report),
      ...previewLine,
    ];
  }
  return [
    "COMMIT ALLOWED",
    report.stagedFileCount === 0
      ? "No staged changes. Commit allowed."
      : "All checks passed. Commit allowed.",
    automaticCountLine(report),
    ...previewLine,
  ];
}

function automaticTextLines(
  report: ScanReport,
  sanitized: ReturnType<typeof validateReportDisplayStrings>,
  presentation: TerminalPresentation,
  width: number,
  verbose: boolean,
): string[] {
  const selectedFindings = validateReportDisplayStrings({
    checks: [],
    summary: { findings: presentation.findings },
  }).summaryFindings;
  const sections = buildScanResultSections(
    { ...report, checks: sanitized.checks },
    { ...presentation, findings: selectedFindings },
  );
  const callouts = buildReportCallouts(
    presentation,
    report.presentationPolicy.agentGuidance,
  );
  return [
    ...calloutLines(callouts.opening, width),
    "",
    ...findingSectionLines(
      "BLOCKING FINDINGS",
      sections.blockingFindings,
      width,
      verbose,
    ),
    ...findingSectionLines(
      "WARNINGS",
      sections.warningFindings,
      width,
      verbose,
    ),
    ...disclosureSectionLines(sections.disclosures, width),
    ...reportWarningsSectionLines(sections.reportWarnings, width),
    ...incompleteSectionLines(sections.incompleteChecks, width),
    "",
    "SCAN RESULT",
    ...automaticHeadline(report, presentation).flatMap((line) =>
      wrapWords(line, width),
    ),
    "",
    ...calloutLines(callouts.closing, width, sections.automaticFixes),
  ];
}

function guidanceLines(
  report: ScanReport,
  presentation: TerminalPresentation | undefined,
  width: number,
): string[] {
  if (
    presentation?.abbreviated !== true ||
    presentation.reportPath === undefined ||
    presentation.maximumAge === undefined
  ) {
    return [];
  }
  return [
    "",
    ...nextStepsLines({
      outcome: report.outcome,
      shown: presentation.findings.length,
      total: presentation.totalFindingCount,
      reportPath: presentation.reportPath,
      maximumAge: presentation.maximumAge,
      automaticFixes: buildScanResultSections(report, presentation)
        .automaticFixes,
    }).flatMap((line) =>
      line === ""
        ? [""]
        : line.startsWith("Full report: ")
          ? opaquePathLines("Full report", presentation.reportPath!, width)
          : wrapWords(line, width),
    ),
  ];
}

function deliveryFallbackLines(
  presentation: TerminalPresentation | undefined,
  width: number,
): string[] {
  if (presentation?.completeOutputFallback !== true) return [];
  const count = presentation.totalFindingCount;
  const findingLabel = count === 1 ? "finding is" : "findings are";
  return [
    "",
    "REPORT DELIVERY WARNING",
    ...wrapWords(
      "Zedbee could not safely retain the temporary report, so it was removed.",
      width,
    ),
    ...wrapWords(
      `Nothing was hidden; all ${count} ${findingLabel} shown above.`,
      width,
    ),
  ];
}

export function renderText(
  report: ScanReport,
  options: TextRendererOptions,
): string {
  const sanitized = validateReportDisplayStrings(report);
  const width = Math.max(20, options.width);
  if (options.presentation?.automatic === true) {
    return `${styleTextLines(
      automaticTextLines(
        report,
        sanitized,
        options.presentation,
        width,
        options.verbose === true,
      ),
      options.color,
    ).join("\n")}\n`;
  }
  const displayedFindings =
    options.presentation === undefined
      ? sanitized.summaryFindings
      : validateReportDisplayStrings({
          checks: [],
          summary: { findings: options.presentation.findings },
        }).summaryFindings;
  const lines = [
    ...headline(report).flatMap((line) => wrapWords(line, width)),
    ...incompleteSectionLines(sanitized.checks, width),
    ...renderedFindings(displayedFindings, width, options.verbose === true),
    ...disclosureLines(report, width),
    ...completeManagedFixLines(sanitized.summaryFindings, width),
    ...guidanceLines(report, options.presentation, width),
    ...maintenanceWarningLines(options.presentation?.warnings ?? [], width),
    ...deliveryFallbackLines(options.presentation, width),
  ];
  return `${styleTextLines(lines, options.color).join("\n")}\n`;
}
