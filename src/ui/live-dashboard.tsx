import { Box, Text } from "ink";
import type { ScanEvent } from "../checks/events.js";
import type { CheckResult } from "../core/types.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

type LiveStatus =
  "QUEUED" | "RUNNING" | "PASS" | "WARN" | "FAIL" | "INCOMPLETE";

interface CheckState {
  id: string;
  status: LiveStatus;
  result?: CheckResult;
}

const CHECK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  formatting: "Formatting",
  lint: "Lint",
  types: "TypeScript",
  cyclomaticComplexity: "Cyclomatic complexity",
  readabilityComplexity: "Readability complexity",
  structuralSecurity: "Structural security",
  secrets: "Secrets",
  duplication: "Duplication",
  dependencyArchitecture: "Dependency architecture",
  deadCode: "Dead code",
  reactCorrectness: "React correctness",
  reactAccessibility: "React accessibility",
  vulnerabilities: "Vulnerabilities",
});

export function checkLabel(checkId: string): string {
  return CHECK_LABELS[checkId] ?? checkId;
}

function resultStatus(result: CheckResult): LiveStatus {
  if (result.status === "incomplete") {
    return "INCOMPLETE";
  }
  if (result.findings.some((finding) => finding.severity === "error")) {
    return "FAIL";
  }
  if (result.findings.length > 0) {
    return "WARN";
  }
  return result.status === "skipped" ? "PASS" : "PASS";
}

function statesFrom(events: readonly ScanEvent[]): CheckState[] {
  const states = new Map<string, CheckState>();
  for (const event of events) {
    if (event.type === "network-disclosure") continue;
    const key = `${event.checkId}\u0000${event.target}`;
    const humanCheck = checkLabel(event.checkId);
    const label =
      event.target === "." ? humanCheck : `${humanCheck} · ${event.target}`;
    if (event.type === "check-queued") {
      states.set(key, { id: label, status: "QUEUED" });
    } else if (event.type === "check-running") {
      states.set(key, { id: label, status: "RUNNING" });
    } else {
      states.set(key, {
        id: label,
        status: resultStatus(event.result),
        result: event.result,
      });
    }
  }
  return [...states.values()];
}

function statusColor(status: LiveStatus): string {
  if (status === "PASS") {
    return ZEDBEE_THEME.pass;
  }
  if (status === "WARN" || status === "INCOMPLETE") {
    return ZEDBEE_THEME.warning;
  }
  if (status === "FAIL") {
    return ZEDBEE_THEME.failure;
  }
  return ZEDBEE_THEME.secondary;
}

function statusIcon(status: LiveStatus, animations: boolean): string {
  if (status === "PASS") return "✓";
  if (status === "WARN") return "⚠";
  if (status === "FAIL" || status === "INCOMPLETE") return "✕";
  if (status === "RUNNING") return animations ? "⠋" : "●";
  return "·";
}

export function LiveDashboard({
  events,
  elapsedMs,
  width,
  color,
  animations,
}: {
  events: readonly ScanEvent[];
  elapsedMs: number;
  width: number;
  color: boolean;
  animations: boolean;
}) {
  const states = statesFrom(events);
  const completed = states.filter(
    (state) => state.status !== "QUEUED" && state.status !== "RUNNING",
  ).length;
  const panelWidth = width >= 88 ? Math.floor((width - 3) / 2) : width;
  const recent = events.slice(-6);

  const checks = (
    <Box
      flexDirection="column"
      width={panelWidth}
      borderStyle="single"
      {...(color ? { borderColor: ZEDBEE_THEME.border } : {})}
      paddingX={1}
    >
      <Text bold {...colorProp(color, ZEDBEE_THEME.secondary)}>
        CHECKS
      </Text>
      {states.map((state) => (
        <Box key={state.id}>
          <Text {...colorProp(color, statusColor(state.status))}>
            {statusIcon(state.status, animations)} {state.status.padEnd(10)}
          </Text>
          <Text {...colorProp(color, ZEDBEE_THEME.primary)}>{state.id}</Text>
        </Box>
      ))}
      <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
        PROGRESS {completed}/{states.length} {(elapsedMs / 1000).toFixed(1)}s
      </Text>
    </Box>
  );

  const activity = (
    <Box
      flexDirection="column"
      width={panelWidth}
      borderStyle="single"
      {...(color ? { borderColor: ZEDBEE_THEME.border } : {})}
      paddingX={1}
    >
      <Text bold {...colorProp(color, ZEDBEE_THEME.secondary)}>
        ACTIVITY
      </Text>
      {recent.map((event, index) => (
        <Text
          key={`${event.checkId}-${event.type}-${index}`}
          {...colorProp(color, ZEDBEE_THEME.secondary)}
        >
          {event.type === "network-disclosure"
            ? "↗"
            : event.type === "check-running"
              ? "●"
              : event.type === "check-completed"
                ? "✓"
                : "·"}{" "}
          {checkLabel(event.checkId)}
          {event.target === "." ? "" : ` · ${event.target}`}:{" "}
          {event.type === "network-disclosure"
            ? `online metadata → ${event.services.join(", ")}`
            : event.type.replace("check-", "")}
        </Text>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column" width={width}>
      <Box marginBottom={1}>
        <Text bold {...colorProp(color, ZEDBEE_THEME.yellow)}>
          ZEDBEE
        </Text>
        <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
          {" "}
          PRE-COMMIT SCAN
        </Text>
      </Box>
      <Box flexDirection={width >= 88 ? "row" : "column"} gap={1}>
        {checks}
        {activity}
      </Box>
    </Box>
  );
}
