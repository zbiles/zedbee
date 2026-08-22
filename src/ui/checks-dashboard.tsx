import { Box, Text } from "ink";
import {
  configurationOverrideLine,
  configurationSummary,
  configurationValueLine,
  type CheckDescription,
} from "../commands/checks.js";
import {
  brandedCommandContentWidth,
  BrandedCommandFrame,
  BrandedCommandPanel,
  BrandedCommandPanelRule,
} from "./branded-command-frame.js";
import { renderStaticInk } from "./render-static.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

function severityTone(severity: string): string {
  if (severity === "error") return ZEDBEE_THEME.failure;
  if (severity === "warn") return ZEDBEE_THEME.warning;
  return ZEDBEE_THEME.muted;
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
  const customizedValues = Object.entries(check.configuration.values).filter(
    ([, value]) => value.customized,
  );

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
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        {configurationSummary(check.configuration)}
      </Text>
      {customizedValues.map(([key, value]) => (
        <Text key={key} wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
          {configurationValueLine(key, value)}
        </Text>
      ))}
      {check.configuration.overrides.map((override) => (
        <Text
          key={override.files.join("|")}
          wrap="wrap"
          {...colorProp(color, ZEDBEE_THEME.secondary)}
        >
          {configurationOverrideLine(override.files, override.values)}
        </Text>
      ))}
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
    <BrandedCommandPanel title="CHECKS" width={width} color={color}>
      {checks.map((check, index) => (
        <Box key={check.id} flexDirection="column">
          <CheckEntry check={check} color={color} />
          {index < checks.length - 1 ? (
            <BrandedCommandPanelRule width={width} color={color} />
          ) : null}
        </Box>
      ))}
      <Text> </Text>
    </BrandedCommandPanel>
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
  await renderStaticInk(<ChecksDashboard checks={checks} {...options} />, {
    width: options.width,
  });
}
