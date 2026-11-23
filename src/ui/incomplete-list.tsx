import { presentIncompleteChecks } from "../reporting/incomplete-checks.js";
import { Box, Text } from "ink";
import type { CheckResult } from "../core/types.js";
import type { ScanReport } from "../scan/report.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

function Field({
  label,
  value,
  width,
  color,
  tone,
}: {
  label: string;
  value: string;
  width: number;
  color: boolean;
  tone: string;
}) {
  const prefix = `${label}: `;
  const prefixWidth = Array.from(prefix).length;
  return (
    <Box width={width}>
      <Box width={prefixWidth} flexShrink={0}>
        <Text {...colorProp(color, tone)}>{prefix}</Text>
      </Box>
      <Box width={Math.max(1, width - prefixWidth)} flexDirection="column">
        <Text wrap="wrap" {...colorProp(color, tone)}>
          {value}
        </Text>
      </Box>
    </Box>
  );
}

export function IncompleteList({
  checks,
  comparison,
  width,
  color,
}: {
  checks: readonly CheckResult[];
  comparison?: Pick<ScanReport, "mode" | "mergeParents">;
  width: number;
  color: boolean;
}) {
  const incomplete = presentIncompleteChecks(checks, comparison);
  if (incomplete.length === 0) return null;

  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Text bold {...colorProp(color, ZEDBEE_THEME.warning)}>
        ⚠ INCOMPLETE CHECKS
      </Text>
      {incomplete.map(({ title, fields }, index) => (
        <Box key={index} flexDirection="column" width={width} marginTop={1}>
          <Text bold wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
            {title}
          </Text>
          {fields.map(({ label, value }, fieldIndex) => (
            <Field
              key={fieldIndex}
              label={label}
              value={value}
              width={width}
              color={color}
              tone={
                label === "Issue" || label === "Fix"
                  ? ZEDBEE_THEME.primary
                  : ZEDBEE_THEME.secondary
              }
            />
          ))}
        </Box>
      ))}
    </Box>
  );
}
