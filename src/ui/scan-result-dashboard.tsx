import { Box, Text } from "ink";
import { findingCheckLabel } from "../reporting/check-label.js";
import {
  buildReportCallouts,
  type ReportCalloutLine,
} from "../reporting/report-callouts.js";
import { opaqueTemporaryReportPath } from "../reporting/report-path.js";
import { buildScanResultSections } from "../reporting/result-sections.js";
import type { TerminalPresentation } from "../reporting/presentation.js";
import { chunkTerminalCells } from "../renderers/terminal-cells.js";
import type { ScanReport } from "../scan/report.js";
import {
  brandedCommandContentWidth,
  BrandedCommandFrame,
  BrandedCommandPanel,
} from "./branded-command-frame.js";
import { FindingsList } from "./findings-list.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

function calloutHeading(value: string): boolean {
  return (
    value === "AGENT GUIDANCE" ||
    value === "AGENT NEXT STEP" ||
    value === "COMPLETE REPORT" ||
    value === "REPORT UNAVAILABLE"
  );
}

function Callouts({
  lines,
  width,
  color,
}: {
  readonly lines: readonly ReportCalloutLine[];
  readonly width: number;
  readonly color: boolean;
}) {
  if (lines.length === 0) return null;
  const contentWidth = Math.max(1, width - 2);
  return (
    <Box flexDirection="column" width={width} paddingX={1} marginY={1}>
      {lines.flatMap((line, index) =>
        line.kind === "text"
          ? [
              <Text
                key={`text:${index}`}
                bold={calloutHeading(line.value)}
                wrap="wrap"
                {...colorProp(
                  color,
                  calloutHeading(line.value)
                    ? ZEDBEE_THEME.secondary
                    : ZEDBEE_THEME.primary,
                )}
              >
                {line.value}
              </Text>,
            ]
          : chunkTerminalCells(
              opaqueTemporaryReportPath(line.path),
              contentWidth,
            ).map((pathLine, pathIndex) => (
              <Text
                key={`path:${index}:${pathIndex}`}
                {...colorProp(color, ZEDBEE_THEME.primary)}
              >
                {pathLine}
              </Text>
            )),
      )}
    </Box>
  );
}

function outcomeCopy(report: ScanReport): {
  readonly heading: string;
  readonly detail: string;
  readonly tone: string;
  readonly symbol: string;
} {
  if (report.outcome === "blocked") {
    return {
      heading: "COMMIT BLOCKED",
      detail: "A check failed. Commit blocked.",
      tone: ZEDBEE_THEME.failure,
      symbol: "×",
    };
  }
  if (report.outcome === "incomplete") {
    return {
      heading: "SCAN INCOMPLETE",
      detail:
        "A required check could not finish. Review INCOMPLETE CHECKS above for details. Commit blocked.",
      tone: ZEDBEE_THEME.warning,
      symbol: "!",
    };
  }
  return {
    heading: "COMMIT ALLOWED",
    detail:
      report.stagedFileCount === 0
        ? "No staged changes. Commit allowed."
        : "All checks passed. Commit allowed.",
    tone: ZEDBEE_THEME.pass,
    symbol: "✓",
  };
}

function countLine(report: ScanReport): string {
  const checkLabel = report.summary.passed === 1 ? "check" : "checks";
  const blockingLabel = report.summary.failed === 1 ? "finding" : "findings";
  const warningLabel = report.summary.warnings === 1 ? "finding" : "findings";
  return `${report.summary.passed} ${checkLabel} passed · ${report.summary.failed} blocking ${blockingLabel} · ${report.summary.warnings} warning ${warningLabel}`;
}

function ResultContent({
  report,
  presentation,
  width,
  color,
}: {
  readonly report: ScanReport;
  readonly presentation: TerminalPresentation;
  readonly width: number;
  readonly color: boolean;
}) {
  const outcome = outcomeCopy(report);
  return (
    <Box
      flexDirection="column"
      width={width}
      paddingX={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <Text bold {...colorProp(color, outcome.tone)}>
        {outcome.symbol} {outcome.heading}
      </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.primary)}>
        {outcome.detail}
      </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        {countLine(report)}
      </Text>
      {presentation.abbreviated ? (
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
          Showing {presentation.findings.length} of{" "}
          {presentation.totalFindingCount} findings.
        </Text>
      ) : null}
    </Box>
  );
}

function FindingPanel({
  title,
  findings,
  width,
  color,
}: {
  readonly title: "BLOCKING FINDINGS" | "WARNINGS";
  readonly findings: TerminalPresentation["findings"];
  readonly width: number;
  readonly color: boolean;
}) {
  if (findings.length === 0) return null;
  const contentWidth = Math.max(1, width - 6);
  return (
    <Box>
      <BrandedCommandPanel title={title} width={width} color={color}>
        <Box
          flexDirection="column"
          paddingX={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <FindingsList
            findings={findings}
            width={contentWidth}
            color={color}
            firstItemMarginTop={0}
          />
        </Box>
      </BrandedCommandPanel>
    </Box>
  );
}

function LabeledValue({
  label,
  value,
  width,
  color,
  tone = ZEDBEE_THEME.primary,
}: {
  readonly label: string;
  readonly value: string;
  readonly width: number;
  readonly color: boolean;
  readonly tone?: string;
}) {
  const prefix = `${label}: `;
  return (
    <Box width={width}>
      <Box width={prefix.length} flexShrink={0}>
        <Text bold {...colorProp(color, tone)}>
          {prefix}
        </Text>
      </Box>
      <Box width={Math.max(1, width - prefix.length)} flexDirection="column">
        <Text wrap="wrap" {...colorProp(color, tone)}>
          {value}
        </Text>
      </Box>
    </Box>
  );
}

function DisclosuresPanel({
  disclosures,
  width,
  color,
}: {
  readonly disclosures: ScanReport["networkDisclosures"];
  readonly width: number;
  readonly color: boolean;
}) {
  if (disclosures.length === 0) return null;
  return (
    <Box>
      <BrandedCommandPanel title="DISCLOSURES" width={width} color={color}>
        <Box
          flexDirection="column"
          paddingX={2}
          paddingTop={1}
          paddingBottom={1}
        >
          {disclosures.map((disclosure, index) => (
            <Text
              key={`${disclosure.checkId}:${disclosure.target}:${index}`}
              wrap="wrap"
              {...colorProp(color, ZEDBEE_THEME.secondary)}
            >
              ↗ {disclosure.checkId} sent {disclosure.metadata.join(", ")} to{" "}
              {disclosure.services.join(", ")}.
            </Text>
          ))}
        </Box>
      </BrandedCommandPanel>
    </Box>
  );
}

function IncompleteChecksPanel({
  checks,
  width,
  color,
}: {
  readonly checks: ScanReport["checks"];
  readonly width: number;
  readonly color: boolean;
}) {
  if (checks.length === 0) return null;
  const contentWidth = Math.max(1, width - 6);
  return (
    <Box>
      <BrandedCommandPanel
        title="INCOMPLETE CHECKS"
        width={width}
        color={color}
      >
        <Box
          flexDirection="column"
          paddingX={2}
          paddingTop={1}
          paddingBottom={1}
        >
          {checks.map((check, index) => {
            const error = check.error;
            const title =
              error?.code.replaceAll("_", " ") ??
              `${findingCheckLabel(check.checkId).toUpperCase()} INCOMPLETE`;
            return (
              <Box
                key={`${check.checkId}:${error?.code ?? "incomplete"}:${index}`}
                flexDirection="column"
                width={contentWidth}
                marginTop={index === 0 ? 0 : 1}
              >
                <Text
                  bold
                  wrap="wrap"
                  {...colorProp(color, ZEDBEE_THEME.warning)}
                >
                  ! {title}
                </Text>
                {error === undefined ? null : (
                  <>
                    <LabeledValue
                      label="Issue"
                      value={error.message}
                      width={contentWidth}
                      color={color}
                    />
                    {error.path === undefined ? null : (
                      <LabeledValue
                        label="Path"
                        value={error.path}
                        width={contentWidth}
                        color={color}
                        tone={ZEDBEE_THEME.secondary}
                      />
                    )}
                    {error.temporaryPath === undefined ? null : (
                      <LabeledValue
                        label="Cleanup"
                        value={error.temporaryPath}
                        width={contentWidth}
                        color={color}
                        tone={ZEDBEE_THEME.secondary}
                      />
                    )}
                    {error.remediation === undefined ? null : (
                      <LabeledValue
                        label="Fix"
                        value={error.remediation}
                        width={contentWidth}
                        color={color}
                      />
                    )}
                  </>
                )}
              </Box>
            );
          })}
        </Box>
      </BrandedCommandPanel>
    </Box>
  );
}

function ReportWarningsPanel({
  warnings,
  width,
  color,
}: {
  readonly warnings: TerminalPresentation["warnings"];
  readonly width: number;
  readonly color: boolean;
}) {
  if (warnings.length === 0) return null;
  const contentWidth = Math.max(1, width - 6);
  return (
    <Box>
      <BrandedCommandPanel title="REPORT WARNINGS" width={width} color={color}>
        <Box
          flexDirection="column"
          paddingX={2}
          paddingTop={1}
          paddingBottom={1}
        >
          {warnings.map((warning, index) => (
            <Box
              key={`${warning.code}:${warning.path ?? ""}:${index}`}
              flexDirection="column"
              width={contentWidth}
              marginTop={index === 0 ? 0 : 1}
            >
              <Text
                bold
                wrap="wrap"
                {...colorProp(color, ZEDBEE_THEME.warning)}
              >
                ! {warning.code.replaceAll("_", " ")}
              </Text>
              <LabeledValue
                label="Issue"
                value={warning.message}
                width={contentWidth}
                color={color}
              />
              {warning.path === undefined ? null : (
                <LabeledValue
                  label="Path"
                  value={opaqueTemporaryReportPath(warning.path)}
                  width={contentWidth}
                  color={color}
                  tone={ZEDBEE_THEME.secondary}
                />
              )}
            </Box>
          ))}
        </Box>
      </BrandedCommandPanel>
    </Box>
  );
}

export function ScanResultDashboard({
  report,
  presentation,
  width,
  color,
}: {
  readonly report: ScanReport;
  readonly presentation: TerminalPresentation;
  readonly width: number;
  readonly color: boolean;
}) {
  const panelWidth = brandedCommandContentWidth(width);
  const sections = buildScanResultSections(report, presentation);
  const callouts = buildReportCallouts(
    presentation,
    report.presentationPolicy.agentGuidance,
  );
  return (
    <Box flexDirection="column" width={width}>
      <Callouts lines={callouts.opening} width={width} color={color} />
      <BrandedCommandFrame width={width} color={color}>
        <FindingPanel
          title="BLOCKING FINDINGS"
          findings={sections.blockingFindings}
          width={panelWidth}
          color={color}
        />
        <FindingPanel
          title="WARNINGS"
          findings={sections.warningFindings}
          width={panelWidth}
          color={color}
        />
        <DisclosuresPanel
          disclosures={sections.disclosures}
          width={panelWidth}
          color={color}
        />
        <ReportWarningsPanel
          warnings={sections.reportWarnings}
          width={panelWidth}
          color={color}
        />
        <IncompleteChecksPanel
          checks={sections.incompleteChecks}
          width={panelWidth}
          color={color}
        />
        <BrandedCommandPanel
          title="SCAN RESULT"
          width={panelWidth}
          color={color}
        >
          <ResultContent
            report={report}
            presentation={presentation}
            width={panelWidth}
            color={color}
          />
        </BrandedCommandPanel>
      </BrandedCommandFrame>
      <Callouts lines={callouts.closing} width={width} color={color} />
    </Box>
  );
}
