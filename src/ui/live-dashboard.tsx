import { Box, Text } from "ink";
import type { ScanEvent } from "../checks/events.js";
import type { CheckResult } from "../core/types.js";
import { PixelBee } from "./pixel-bee.js";
import { PixelWordmark } from "./pixel-wordmark.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

type LiveStatus =
  "QUEUED" | "RUNNING" | "PASS" | "WARN" | "FAIL" | "SKIPPED" | "INCOMPLETE";

interface CheckState {
  id: string;
  status: LiveStatus;
  startedAt?: number;
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

const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export function checkLabel(checkId: string): string {
  return CHECK_LABELS[checkId] ?? checkId;
}

function resultStatus(result: CheckResult): LiveStatus {
  if (result.status === "skipped") return "SKIPPED";
  if (result.status === "incomplete") return "INCOMPLETE";
  if (result.findings.some((finding) => finding.severity === "error")) {
    return "FAIL";
  }
  if (result.findings.length > 0) return "WARN";
  return "PASS";
}

function stateLabel(checkId: string, target: string): string {
  const humanCheck = checkLabel(checkId);
  return target === "." ? humanCheck : `${humanCheck} · ${target}`;
}

function statesFrom(events: readonly ScanEvent[]): CheckState[] {
  const states = new Map<string, CheckState>();
  for (const event of events) {
    if (event.type === "network-disclosure") continue;
    const key = `${event.checkId}\u0000${event.target}`;
    const existing = states.get(key);
    if (event.type === "check-queued") {
      states.set(key, {
        id: stateLabel(event.checkId, event.target),
        status: "QUEUED",
      });
    } else if (event.type === "check-running") {
      states.set(key, {
        id: existing?.id ?? stateLabel(event.checkId, event.target),
        status: "RUNNING",
        startedAt: event.timestamp,
      });
    } else {
      states.set(key, {
        id: existing?.id ?? stateLabel(event.checkId, event.target),
        status: resultStatus(event.result),
        result: event.result,
      });
    }
  }
  return [...states.values()];
}

function statusColor(status: LiveStatus): string {
  if (status === "PASS") return ZEDBEE_THEME.pass;
  if (status === "WARN" || status === "INCOMPLETE") {
    return ZEDBEE_THEME.warning;
  }
  if (status === "FAIL") return ZEDBEE_THEME.failure;
  if (status === "RUNNING") return ZEDBEE_THEME.wordmark;
  return ZEDBEE_THEME.muted;
}

function statusIcon(
  status: LiveStatus,
  animations: boolean,
  elapsedMs: number,
  index: number,
): string {
  if (status === "PASS") return "✓";
  if (status === "WARN") return "⚠";
  if (status === "FAIL" || status === "INCOMPLETE") return "✕";
  if (status === "SKIPPED") return "−";
  if (status === "RUNNING") {
    return animations
      ? SPINNER_FRAMES[
          Math.floor((elapsedMs + index * 45) / 80) % SPINNER_FRAMES.length
        ]!
      : "●";
  }
  return "·";
}

function statusText(
  state: CheckState,
  now: number,
  animations: boolean,
): string {
  if (state.status === "RUNNING") {
    const duration = `${(
      Math.max(0, now - (state.startedAt ?? now)) / 1000
    ).toFixed(1)}s`;
    return animations ? duration : `running ${duration}`;
  }
  return state.status.toLowerCase();
}

function activityText(event: ScanEvent): string | undefined {
  const label = stateLabel(event.checkId, event.target);
  if (event.type === "check-queued") return undefined;
  if (event.type === "network-disclosure") {
    return `${label}: online metadata → ${event.services.join(", ")}`;
  }
  if (event.type === "check-running") {
    return `${label}: checking…`;
  }
  const status = resultStatus(event.result);
  if (status === "PASS") return `${label}: passed`;
  if (status === "SKIPPED") return `${label}: skipped`;
  if (status === "INCOMPLETE") return `${label}: incomplete`;
  const blocking = event.result.findings.filter(
    ({ severity }) => severity === "error",
  ).length;
  const warnings = event.result.findings.length - blocking;
  if (blocking > 0 && warnings > 0) {
    return `${label}: ${blocking} blocking · ${warnings} warning${warnings === 1 ? "" : "s"}`;
  }
  const count = blocking || warnings;
  const noun = count === 1 ? "finding" : "findings";
  return `${label}: ${count} ${blocking > 0 ? "blocking " : ""}${noun}`;
}

function activityColor(event: ScanEvent): string {
  if (event.type === "network-disclosure") return ZEDBEE_THEME.warning;
  if (event.type === "check-running") return ZEDBEE_THEME.wordmark;
  if (event.type === "check-completed") {
    return statusColor(resultStatus(event.result));
  }
  return ZEDBEE_THEME.muted;
}

function CheckPanel({
  states,
  now,
  elapsedMs,
  animations,
  color,
  width,
}: {
  states: readonly CheckState[];
  now: number;
  elapsedMs: number;
  animations: boolean;
  color: boolean;
  width: number;
}) {
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      {...(color ? { borderColor: ZEDBEE_THEME.border } : {})}
      paddingX={1}
    >
      <Text bold {...colorProp(color, ZEDBEE_THEME.secondary)}>
        CHECKS
      </Text>
      {states.map((state, index) => (
        <Box key={state.id}>
          <Text {...colorProp(color, statusColor(state.status))}>
            {statusIcon(state.status, animations, elapsedMs, index)}{" "}
          </Text>
          <Text
            {...colorProp(
              color,
              state.status === "QUEUED"
                ? ZEDBEE_THEME.muted
                : ZEDBEE_THEME.primary,
            )}
          >
            {state.id}
          </Text>
          <Box flexGrow={1} />
          <Text {...colorProp(color, statusColor(state.status))}>
            {statusText(state, now, animations)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function ActivityPanel({
  events,
  color,
  width,
}: {
  events: readonly ScanEvent[];
  color: boolean;
  width: number;
}) {
  const activity = events
    .map((event) => ({ event, text: activityText(event) }))
    .filter(
      (entry): entry is { event: ScanEvent; text: string } =>
        entry.text !== undefined,
    )
    .slice(-6);
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      {...(color ? { borderColor: ZEDBEE_THEME.border } : {})}
      paddingX={1}
      minHeight={6}
    >
      <Text bold {...colorProp(color, ZEDBEE_THEME.secondary)}>
        ACTIVITY
      </Text>
      {activity.map(({ event, text }, index) => (
        <Text
          key={`${event.checkId}-${event.target}-${event.type}-${index}`}
          {...colorProp(color, activityColor(event))}
        >
          ● {text}
        </Text>
      ))}
    </Box>
  );
}

function SummaryPanel({
  states,
  elapsedMs,
  color,
  width,
}: {
  states: readonly CheckState[];
  elapsedMs: number;
  color: boolean;
  width: number;
}) {
  const completed = states.filter(
    ({ status }) => status !== "QUEUED" && status !== "RUNNING",
  );
  const pass = completed.filter(({ status }) => status === "PASS").length;
  const warn = completed.filter(({ status }) => status === "WARN").length;
  const fail = completed.filter(({ status }) => status === "FAIL").length;
  const incomplete = completed.filter(
    ({ status }) => status === "INCOMPLETE",
  ).length;
  const skipped = completed.filter(({ status }) => status === "SKIPPED").length;
  const progressWidth = Math.max(10, Math.min(32, width - 4));
  const filled =
    states.length === 0
      ? 0
      : Math.round((completed.length / states.length) * progressWidth);
  const barColor =
    fail > 0
      ? ZEDBEE_THEME.failure
      : warn > 0 || incomplete > 0
        ? ZEDBEE_THEME.warning
        : pass === 0 && skipped > 0
          ? ZEDBEE_THEME.muted
          : ZEDBEE_THEME.pass;
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      {...(color ? { borderColor: ZEDBEE_THEME.border } : {})}
      paddingX={1}
    >
      <Text bold {...colorProp(color, ZEDBEE_THEME.secondary)}>
        SUMMARY
      </Text>
      <Box>
        <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
          {(elapsedMs / 1000).toFixed(1)}s
        </Text>
        <Box flexGrow={1} />
        <Text {...colorProp(color, ZEDBEE_THEME.muted)}>elapsed</Text>
      </Box>
      <Text>
        <Text {...colorProp(color, barColor)}>{"█".repeat(filled)}</Text>
        <Text {...colorProp(color, ZEDBEE_THEME.muted)}>
          {"░".repeat(progressWidth - filled)}
        </Text>
      </Text>
      <Text>
        <Text {...colorProp(color, ZEDBEE_THEME.pass)}>{pass} pass</Text>
        {"  "}
        <Text {...colorProp(color, ZEDBEE_THEME.warning)}>{warn} warn</Text>
        {"  "}
        <Text {...colorProp(color, ZEDBEE_THEME.failure)}>{fail} fail</Text>
        {"  "}
        <Text {...colorProp(color, ZEDBEE_THEME.warning)}>
          {incomplete} incomplete
        </Text>
      </Text>
    </Box>
  );
}

export function LiveDashboard({
  events,
  startedAt,
  elapsedMs,
  width,
  color,
  animations,
}: {
  events: readonly ScanEvent[];
  startedAt?: number;
  elapsedMs: number;
  width: number;
  color: boolean;
  animations: boolean;
}) {
  const states = statesFrom(events);
  const now = (startedAt ?? 0) + elapsedMs;
  const wide = width >= 88;
  const contentWidth = Math.max(12, width - 6);
  const panelWidth = wide ? Math.floor((contentWidth - 1) / 2) : contentWidth;
  const checks = (
    <CheckPanel
      states={states}
      now={now}
      elapsedMs={elapsedMs}
      animations={animations}
      color={color}
      width={panelWidth}
    />
  );
  const activity = (
    <ActivityPanel events={events} color={color} width={panelWidth} />
  );
  const summary = (
    <SummaryPanel
      states={states}
      elapsedMs={elapsedMs}
      color={color}
      width={panelWidth}
    />
  );

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      {...(color ? { borderColor: ZEDBEE_THEME.yellow } : {})}
      paddingX={1}
    >
      <Box
        flexDirection={width >= 132 ? "row" : "column"}
        alignItems={width >= 132 ? "center" : "flex-start"}
        marginY={1}
      >
        {width < 40 ? (
          <Text bold {...colorProp(color, ZEDBEE_THEME.wordmark)}>
            ZEDBEE
          </Text>
        ) : (
          <PixelWordmark color={color} compact={width < 74} />
        )}
        {width >= 60 ? (
          <Box
            marginLeft={width >= 132 ? 2 : 0}
            marginTop={width >= 132 ? 0 : 1}
          >
            <PixelBee motion color={color} />
          </Box>
        ) : null}
      </Box>
      {wide ? (
        <Box flexDirection="row">
          {checks}
          <Text> </Text>
          <Box flexDirection="column" gap={1}>
            {activity}
            {summary}
          </Box>
          <Text> </Text>
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box>
            {checks}
            <Text> </Text>
          </Box>
          <Box>
            {activity}
            <Text> </Text>
          </Box>
          <Box>
            {summary}
            <Text> </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
