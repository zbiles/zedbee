import { Box, Text } from "ink";
import type { CheckResult } from "../core/types.js";
import { incompleteCheckTitle, incompleteErrorFields } from "./incomplete-fields.js";
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
  width,
  color,
}: {
  checks: readonly CheckResult[];
  width: number;
  color: boolean;
}) {
  const incomplete = checks.filter((check) => check.status === "incomplete");
  if (incomplete.length === 0) return null;

  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Text bold {...colorProp(color, ZEDBEE_THEME.warning)}>
        ⚠ INCOMPLETE CHECKS
      </Text>
      {incomplete.map((check, index) => {
        const error = check.error;
        return (
          <Box
            key={`${check.checkId}:${error?.code ?? "incomplete"}:${index}`}
            flexDirection="column"
            width={width}
            marginTop={1}
          >
            <Text bold wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
              {`! ${incompleteCheckTitle(check)}`}
            </Text>
            {error === undefined
              ? null
              : incompleteErrorFields(error).map((field) => (
                  <Field
                    key={field.key}
                    label={field.label}
                    value={field.value}
                    width={width}
                    color={color}
                    tone={
                      field.emphasis === "primary"
                        ? ZEDBEE_THEME.primary
                        : ZEDBEE_THEME.secondary
                    }
                  />
                ))}
          </Box>
        );
      })}
    </Box>
  );
}
