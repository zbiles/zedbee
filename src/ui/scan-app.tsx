import { Box, Text } from "ink";
import type { ScanEvent } from "../checks/events.js";
import type { ScanReport } from "../scan/report.js";
import { FindingsList } from "./findings-list.js";
import { LiveDashboard } from "./live-dashboard.js";
import { OutcomeStrip } from "./outcome-strip.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

export interface ScanAppProps {
  events: readonly ScanEvent[];
  elapsedMs: number;
  width: number;
  color: boolean;
  animations: boolean;
  report?: ScanReport;
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
      <FindingsList
        findings={props.report.summary.findings}
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
    </Box>
  );
}
