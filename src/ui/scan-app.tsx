import { Box, Text } from "ink";
import type { ScanEvent } from "../checks/events.js";
import type { ScanReport } from "../scan/report.js";
import { nextStepsLines } from "../reporting/next-steps.js";
import { buildScanResultSections } from "../reporting/result-sections.js";
import { opaqueTemporaryReportPath } from "../reporting/report-path.js";
import type { TerminalPresentation } from "../reporting/presentation.js";
import type { ReportMaintenanceWarning } from "../reporting/temporary-reports.js";
import { FindingsList } from "./findings-list.js";
import { IncompleteList } from "./incomplete-list.js";
import { LiveDashboard } from "./live-dashboard.js";
import { OutcomeStrip } from "./outcome-strip.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";
import { chunkTerminalCells } from "../renderers/terminal-cells.js";

function opaquePathLines(
  label: "Path" | "Full report",
  path: string,
  width: number,
): readonly string[] {
  const prefix = `${label}: `;
  return chunkTerminalCells(
    opaqueTemporaryReportPath(path),
    Math.max(1, width - prefix.length),
  ).map((chunk, index) => (index === 0 ? `${prefix}${chunk}` : chunk));
}

export interface ScanAppProps {
  events: readonly ScanEvent[];
  startedAt?: number;
  elapsedMs: number;
  width: number;
  color: boolean;
  animations: boolean;
  report?: ScanReport;
  presentation?: TerminalPresentation;
}

function MaintenanceWarnings({
  warnings,
  width,
  color,
}: {
  warnings: readonly ReportMaintenanceWarning[];
  width: number;
  color: boolean;
}) {
  if (warnings.length === 0) return null;
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      {warnings.map((warning, index) => (
        <Box
          key={`${warning.code}:${warning.path ?? ""}:${index}`}
          flexDirection="column"
          width={width}
          marginTop={index === 0 ? 0 : 1}
        >
          <Text bold {...colorProp(color, ZEDBEE_THEME.warning)}>
            REPORT MAINTENANCE WARNING
          </Text>
          <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
            {warning.code.replaceAll("_", " ")}
          </Text>
          <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.primary)}>
            Issue: {warning.message}
          </Text>
          {warning.path === undefined
            ? null
            : opaquePathLines("Path", warning.path, width).map(
                (line, lineIndex) => (
                  <Text
                    key={`path:${lineIndex}`}
                    {...colorProp(color, ZEDBEE_THEME.secondary)}
                  >
                    {line}
                  </Text>
                ),
              )}
        </Box>
      ))}
    </Box>
  );
}

function NextSteps({
  report,
  presentation,
  width,
  color,
}: {
  report: ScanReport;
  presentation: TerminalPresentation;
  width: number;
  color: boolean;
}) {
  if (
    !presentation.abbreviated ||
    presentation.reportPath === undefined ||
    presentation.maximumAge === undefined
  ) {
    return null;
  }
  const [heading, ...lines] = nextStepsLines({
    outcome: report.outcome,
    shown: presentation.findings.length,
    total: presentation.totalFindingCount,
    reportPath: presentation.reportPath,
    maximumAge: presentation.maximumAge,
    automaticFixes: buildScanResultSections(report, presentation)
      .automaticFixes,
  });
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Text bold {...colorProp(color, ZEDBEE_THEME.secondary)}>
        {heading}
      </Text>
      {lines.map((line, index) =>
        line === "" ? (
          <Text key={`blank:${index}`}> </Text>
        ) : line.startsWith("Full report: ") ? (
          <Box key={`report:${index}`} flexDirection="column" width={width}>
            {opaquePathLines(
              "Full report",
              presentation.reportPath!,
              width,
            ).map((pathLine, pathIndex) => (
              <Text
                key={`report-path:${pathIndex}`}
                {...colorProp(color, ZEDBEE_THEME.primary)}
              >
                {pathLine}
              </Text>
            ))}
          </Box>
        ) : (
          <Text
            key={`${line}:${index}`}
            wrap="wrap"
            {...colorProp(color, ZEDBEE_THEME.primary)}
          >
            {line}
          </Text>
        ),
      )}
    </Box>
  );
}

function DeliveryFallback({
  presentation,
  width,
  color,
}: {
  presentation: TerminalPresentation | undefined;
  width: number;
  color: boolean;
}) {
  if (presentation?.completeOutputFallback !== true) return null;
  const count = presentation.totalFindingCount;
  const findingLabel = count === 1 ? "finding is" : "findings are";
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Text bold {...colorProp(color, ZEDBEE_THEME.warning)}>
        REPORT DELIVERY WARNING
      </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.primary)}>
        Zedbee could not safely retain the temporary report, so it was removed.
      </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.primary)}>
        Nothing was hidden; all {count} {findingLabel} shown above.
      </Text>
    </Box>
  );
}

export function ScanApp(props: ScanAppProps) {
  if (props.report === undefined) {
    return <LiveDashboard {...props} />;
  }

  const instruction =
    props.report.outcome === "pass"
      ? "✓ Commit allowed."
      : props.report.outcome === "blocked"
        ? "✕ Resolve the findings above, then stage the result."
        : "✕ Restore the incomplete check, then scan again.";
  return (
    <Box flexDirection="column" width={props.width}>
      <OutcomeStrip
        report={props.report}
        width={props.width}
        color={props.color}
      />
      <IncompleteList
        checks={props.report.checks}
        width={props.width}
        color={props.color}
      />
      <FindingsList
        findings={props.presentation?.findings ?? props.report.summary.findings}
        width={props.width}
        color={props.color}
      />
      {props.report.networkDisclosures.map((disclosure) => (
        <Box key={`${disclosure.checkId}:${disclosure.target}`} marginTop={1}>
          <Text {...colorProp(props.color, ZEDBEE_THEME.secondary)}>
            ↗ {disclosure.checkId} sent {disclosure.metadata.join(", ")} to{" "}
            {disclosure.services.join(", ")}.
          </Text>
        </Box>
      ))}
      {props.presentation?.abbreviated === true ? null : (
        <Box marginTop={1}>
          <Text
            {...colorProp(
              props.color,
              props.report.outcome === "pass"
                ? ZEDBEE_THEME.pass
                : ZEDBEE_THEME.failure,
            )}
          >
            {instruction}
          </Text>
        </Box>
      )}
      {props.presentation === undefined ? null : (
        <NextSteps
          report={props.report}
          presentation={props.presentation}
          width={props.width}
          color={props.color}
        />
      )}
      <MaintenanceWarnings
        warnings={props.presentation?.warnings ?? []}
        width={props.width}
        color={props.color}
      />
      <DeliveryFallback
        presentation={props.presentation}
        width={props.width}
        color={props.color}
      />
    </Box>
  );
}
