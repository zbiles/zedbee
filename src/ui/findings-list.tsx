import { Box, Text } from "ink";
import type { Finding } from "../core/types.js";
import { findingCheckLabel } from "../reporting/check-label.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

function severityColor(finding: Finding): string {
  return finding.severity === "error"
    ? ZEDBEE_THEME.failure
    : ZEDBEE_THEME.warning;
}

function DetailRow({
  label,
  value,
  width,
  color,
  boldLabel = false,
}: {
  label: string;
  value: string;
  width: number;
  color: boolean;
  boldLabel?: boolean;
}) {
  const labelWidth = Array.from(label).length;
  return (
    <Box width={width}>
      <Box width={labelWidth} flexShrink={0}>
        <Text bold={boldLabel} {...colorProp(color, ZEDBEE_THEME.primary)}>
          {label}
        </Text>
      </Box>
      <Box width={Math.max(1, width - labelWidth)} flexDirection="column">
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.primary)}>
          {value}
        </Text>
      </Box>
    </Box>
  );
}

export function FindingsList({
  findings,
  width,
  color,
}: {
  findings: readonly Finding[];
  width: number;
  color: boolean;
}) {
  return (
    <Box flexDirection="column" width={width}>
      {findings.map((finding) => {
        const header = `${findingCheckLabel(finding.check)}  ${finding.rule}`;
        const location =
          finding.location === undefined
            ? undefined
            : `${finding.location.file}:${finding.location.startLine ?? 1}`;
        const headerFits =
          location !== undefined &&
          Array.from(header).length + Array.from(location).length + 8 <= width;
        const excerpt = finding.sourceExcerpt;
        const source =
          excerpt === undefined
            ? undefined
            : finding.check === "secrets" || excerpt.redacted
              ? "[redacted]"
              : `${excerpt.text ?? ""}${excerpt.truncated ? "…" : ""}`;

        return (
          <Box
            key={finding.id}
            flexDirection="column"
            marginTop={1}
            width={width}
          >
            {headerFits ? (
              <Box width={width} justifyContent="space-between">
                <Text {...colorProp(color, severityColor(finding))}>
                  {header}
                </Text>
                <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
                  {location}
                </Text>
              </Box>
            ) : (
              <Box flexDirection="column" width={width}>
                <Text wrap="wrap" {...colorProp(color, severityColor(finding))}>
                  {header}
                </Text>
                {location === undefined ? null : (
                  <Box width={width} justifyContent="flex-end">
                    <Text
                      wrap="wrap"
                      {...colorProp(color, ZEDBEE_THEME.secondary)}
                    >
                      {location}
                    </Text>
                  </Box>
                )}
              </Box>
            )}
            {excerpt === undefined ? null : (
              <Box width={width}>
                <Box width={7} flexShrink={0}>
                  <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
                    {String(excerpt.line).padStart(4)} │{" "}
                  </Text>
                </Box>
                <Box width={Math.max(1, width - 7)} flexDirection="column">
                  <Text
                    wrap="wrap"
                    {...colorProp(color, ZEDBEE_THEME.secondary)}
                  >
                    {source}
                  </Text>
                </Box>
              </Box>
            )}
            <DetailRow
              label="Issue: "
              value={finding.message}
              width={width}
              color={color}
              boldLabel
            />
            {finding.remediation === undefined ? null : (
              <DetailRow
                label="Fix: "
                value={finding.remediation}
                width={width}
                color={color}
                boldLabel
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}
