import { Box, Text } from "ink";
import type { ScanEvent } from "../checks/events.js";
import type { CheckResult } from "../core/types.js";
import { PixelBee } from "./pixel-bee.js";
import { PixelClock, pixelClockWidth } from "./pixel-clock.js";
import { PixelWordmark, pixelWordmarkWidth } from "./pixel-wordmark.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";
import { checkLabel } from "../reporting/check-label.js";

type LiveStatus =
  "QUEUED" | "RUNNING" | "PASS" | "WARN" | "FAIL" | "SKIPPED" | "INCOMPLETE";

interface CheckState {
  id: string;
  status: LiveStatus;
  startedAt?: number;
  result?: CheckResult;
}

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
  if (status === "RUNNING") return ZEDBEE_THEME.pass;
  return ZEDBEE_THEME.muted;
}

function statusIcon(
  status: LiveStatus,
  animations: boolean,
  elapsedMs: number,
  index: number,
): string {
  if (status === "PASS") return "✓";
  if (status === "WARN" || status === "INCOMPLETE") return "!";
  if (status === "FAIL") return "×";
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
  if (event.type === "check-running") return ZEDBEE_THEME.pass;
  if (event.type === "check-completed") {
    return statusColor(resultStatus(event.result));
  }
  return ZEDBEE_THEME.muted;
}

function HorizontalRule({
  width,
  color,
  tone = ZEDBEE_THEME.border,
}: {
  width: number;
  color: boolean;
  tone?: string;
}) {
  return (
    <Box marginX={-1}>
      <Text {...colorProp(color, ZEDBEE_THEME.border)}>├</Text>
      <Text {...colorProp(color, tone)}>
        {"─".repeat(Math.max(1, width - 2))}
      </Text>
      <Text {...colorProp(color, ZEDBEE_THEME.border)}>┤</Text>
    </Box>
  );
}

function PanelHeading({
  label,
  width,
  color,
}: {
  label: string;
  width: number;
  color: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Box paddingX={2}>
        <Text {...colorProp(color, ZEDBEE_THEME.muted)}>{label}</Text>
      </Box>
      <HorizontalRule width={width} color={color} />
    </Box>
  );
}

function SummaryChip({
  count,
  label,
  width,
  tone,
  color,
}: {
  count: number;
  label: string;
  width: number;
  tone: string;
  color: boolean;
}) {
  return (
    <Box
      width={width}
      height={2}
      alignItems="center"
      justifyContent="center"
      {...(color ? { backgroundColor: tone } : {})}
    >
      <Text bold {...(color ? { color: ZEDBEE_THEME.beeBlack } : {})}>
        {count} {label}
      </Text>
    </Box>
  );
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
    >
      <PanelHeading label="CHECKS" width={width} color={color} />
      {states.map((state, index) => (
        <Box key={state.id} flexDirection="column">
          <Box paddingX={2}>
            <Box width={3} justifyContent="center">
              <Text {...colorProp(color, statusColor(state.status))}>
                {statusIcon(state.status, animations, elapsedMs, index)}
              </Text>
            </Box>
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
          {index < states.length - 1 ? (
            <HorizontalRule
              width={width}
              color={color}
              tone={ZEDBEE_THEME.divider}
            />
          ) : null}
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
      minHeight={8}
    >
      <PanelHeading label="ACTIVITY" width={width} color={color} />
      <Box
        flexDirection="column"
        flexGrow={1}
        justifyContent="flex-end"
        paddingX={2}
      >
        {activity.map(({ event, text }, index) => (
          <Text key={`${event.checkId}-${event.target}-${event.type}-${index}`}>
            <Text {...colorProp(color, activityColor(event))}>●</Text>
            <Text {...colorProp(color, ZEDBEE_THEME.secondary)}> {text}</Text>
          </Text>
        ))}
      </Box>
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
  const elapsedValue = (elapsedMs / 1000).toFixed(1);
  const elapsedLabel = `${elapsedValue}s`;
  const groupWidth = Math.max(1, width - 6);
  const showPixelClock = groupWidth >= pixelClockWidth(elapsedValue) + 9;
  const showElapsedCopy = groupWidth >= elapsedLabel.length + "elapsed".length;
  const chipsInline = groupWidth >= 23;
  const availableForChips = groupWidth - 2;
  const base = Math.floor(availableForChips / 3);
  const remainder = availableForChips % 3;
  const chipWidths = chipsInline
    ? [0, 1, 2].map((index) => base + (index < remainder ? 1 : 0))
    : [groupWidth, groupWidth, groupWidth];
  const progressWidth = groupWidth;
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
    >
      <PanelHeading label="SUMMARY" width={width} color={color} />
      <Box flexDirection="column" paddingX={2} paddingTop={1}>
        <Box alignItems="flex-end">
          {showPixelClock ? (
            <>
              <PixelClock value={elapsedValue} color={color} />
              <Text {...colorProp(color, ZEDBEE_THEME.primary)}>s</Text>
            </>
          ) : (
            <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
              {elapsedLabel}
            </Text>
          )}
          {showElapsedCopy ? (
            <>
              <Box flexGrow={1} />
              <Text {...colorProp(color, ZEDBEE_THEME.muted)}>elapsed</Text>
            </>
          ) : null}
        </Box>
        <Box marginBottom={1}>
          <Text>
            <Text {...colorProp(color, barColor)}>{"▄".repeat(filled)}</Text>
            <Text {...colorProp(color, ZEDBEE_THEME.divider)}>
              {(color ? "▄" : "▂").repeat(progressWidth - filled)}
            </Text>
          </Text>
        </Box>
        <Box flexDirection={chipsInline ? "row" : "column"} gap={1}>
          <SummaryChip
            count={pass}
            label="pass"
            width={chipWidths[0]!}
            tone={ZEDBEE_THEME.pass}
            color={color}
          />
          <SummaryChip
            count={warn}
            label="warn"
            width={chipWidths[1]!}
            tone={ZEDBEE_THEME.warning}
            color={color}
          />
          <SummaryChip
            count={fail}
            label="fail"
            width={chipWidths[2]!}
            tone={ZEDBEE_THEME.failure}
            color={color}
          />
        </Box>
      </Box>
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
  const showBrandBee = width >= 69;
  const compactBrand = width < 129;
  const contentWidth = Math.max(12, width - 7);
  const panelWidth = wide ? Math.floor((contentWidth - 2) / 2) : contentWidth;
  const brandHeight = width < 40 ? 1 : 5;
  const brandWidth =
    width < 40 ? "ZEDBEE".length : pixelWordmarkWidth(compactBrand);
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

  const dashboard = (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      {...(color ? { borderColor: ZEDBEE_THEME.yellow } : {})}
      paddingLeft={2}
      paddingRight={1}
    >
      <Box
        height={brandHeight}
        position="relative"
        marginLeft={1}
        marginTop={showBrandBee ? 2 : 1}
        marginBottom={showBrandBee ? 2 : 1}
      >
        {width < 40 ? (
          <Text bold {...colorProp(color, ZEDBEE_THEME.wordmark)}>
            ZEDBEE
          </Text>
        ) : (
          <PixelWordmark color={color} compact={compactBrand} />
        )}
        {showBrandBee ? (
          <Box position="absolute" left={brandWidth + 2} top={-5}>
            <PixelBee
              motion
              motionPixel="w"
              compact={compactBrand}
              sparse
              color={color}
            />
          </Box>
        ) : null}
      </Box>
      {wide ? (
        <Box flexDirection="row">
          {checks}
          <Box width={2} />
          <Box flexDirection="column" gap={0}>
            {activity}
            {summary}
          </Box>
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

  return showBrandBee ? (
    <Box flexDirection="column" width={width} paddingTop={2}>
      {dashboard}
    </Box>
  ) : (
    dashboard
  );
}
