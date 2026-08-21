import { PassThrough } from "node:stream";
import { Box, Text, render } from "ink";
import type { CheckDescription } from "../commands/checks.js";
import {
  brandedCommandContentWidth,
  BrandedCommandFrame,
} from "./branded-command-frame.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

function severityTone(severity: string): string {
  if (severity === "error") return ZEDBEE_THEME.failure;
  if (severity === "warn") return ZEDBEE_THEME.warning;
  return ZEDBEE_THEME.muted;
}

function HorizontalRule({ width, color }: { width: number; color: boolean }) {
  return (
    <Box marginX={-1}>
      <Text {...colorProp(color, ZEDBEE_THEME.border)}>├</Text>
      <Text {...colorProp(color, ZEDBEE_THEME.border)}>
        {"─".repeat(Math.max(1, width - 2))}
      </Text>
      <Text {...colorProp(color, ZEDBEE_THEME.border)}>┤</Text>
    </Box>
  );
}

function CheckEntry({
  check,
  color,
}: {
  readonly check: CheckDescription;
  readonly color: boolean;
}) {
  const applicable = check.applicability === "applicable";
  const applicabilityTone = applicable ? ZEDBEE_THEME.pass : ZEDBEE_THEME.muted;
  const targets =
    check.targets.length === 0 ? "none" : check.targets.join(", ");

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box>
        <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
          {check.id}
        </Text>
        <Box flexGrow={1} minWidth={1} />
        <Text bold {...colorProp(color, applicabilityTone)}>
          {applicable ? "● APPLICABLE" : "○ NOT APPLICABLE"}
        </Text>
        <Text> </Text>
        <Text bold {...colorProp(color, severityTone(check.severity))}>
          SEVERITY: {check.severity.toUpperCase()}
        </Text>
      </Box>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        {check.description}
      </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        Engine: {check.engine.name} {check.engine.version} (
        {check.engine.license})
      </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        Targets: {targets} · Timing: {check.timing} · Cost:{" "}
        {check.executionClass}
      </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        Network: {check.network}
      </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
        Limitation: {check.limitation}
      </Text>
      {check.reason === undefined ? null : (
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
          Reason: {check.reason}
        </Text>
      )}
    </Box>
  );
}

function ChecksPanel({
  checks,
  width,
  color,
}: {
  readonly checks: readonly CheckDescription[];
  readonly width: number;
  readonly color: boolean;
}) {
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      {...(color
        ? {
            borderColor: ZEDBEE_THEME.border,
            borderBackgroundColor: "#000000",
          }
        : {})}
    >
      <Box paddingX={2}>
        <Text {...colorProp(color, ZEDBEE_THEME.muted)}>CHECKS</Text>
      </Box>
      <HorizontalRule width={width} color={color} />
      {checks.map((check, index) => (
        <Box key={check.id} flexDirection="column">
          <CheckEntry check={check} color={color} />
          {index < checks.length - 1 ? (
            <HorizontalRule width={width} color={color} />
          ) : null}
        </Box>
      ))}
      <Text> </Text>
    </Box>
  );
}

export function ChecksDashboard({
  checks,
  width,
  color,
}: {
  readonly checks: readonly CheckDescription[];
  readonly width: number;
  readonly color: boolean;
}) {
  return (
    <BrandedCommandFrame width={width} color={color}>
      <ChecksPanel
        checks={checks}
        width={brandedCommandContentWidth(width)}
        color={color}
      />
    </BrandedCommandFrame>
  );
}

export async function runInkChecks(
  checks: readonly CheckDescription[],
  options: { readonly width: number; readonly color: boolean },
): Promise<void> {
  const chunks: Buffer[] = [];
  const sink = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  sink.columns = options.width;
  sink.rows = process.stdout.rows ?? 24;
  sink.isTTY = false;
  sink.on("data", (chunk: Buffer) => chunks.push(chunk));
  const app = render(<ChecksDashboard checks={checks} {...options} />, {
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 1,
    stdout: sink as unknown as NodeJS.WriteStream,
  });
  try {
    await app.waitUntilRenderFlush();
  } finally {
    app.unmount();
    await app.waitUntilExit();
  }
  const output = Buffer.concat(chunks).toString("utf8");
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error == null) resolve();
      else reject(error);
    });
  });
}
