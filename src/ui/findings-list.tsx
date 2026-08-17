import { Box, Text } from "ink";
import type { Finding } from "../core/types.js";
import { findingCheckLabel } from "../reporting/check-label.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

const DETAIL_INDENT = 3;

function detailGeometry(width: number): {
  indent: number;
  contentWidth: number;
} {
  const indent = Math.min(DETAIL_INDENT, Math.max(0, width - 1));
  return { indent, contentWidth: Math.max(1, width - indent) };
}

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
  const { indent, contentWidth } = detailGeometry(width);
  return (
    <Box width={width}>
      <Box width={indent} flexShrink={0} />
      <Box width={contentWidth}>
        <Box width={labelWidth} flexShrink={0}>
          <Text bold={boldLabel} {...colorProp(color, ZEDBEE_THEME.primary)}>
            {label}
          </Text>
        </Box>
        <Box
          width={Math.max(1, contentWidth - labelWidth)}
          flexDirection="column"
        >
          <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.primary)}>
            {value}
          </Text>
        </Box>
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
              : (excerpt.text ?? "");
        const sourceLabel =
          excerpt === undefined ? undefined : `${excerpt.line} │ `;
        const { indent, contentWidth } = detailGeometry(width);

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
                <Box width={indent} flexShrink={0} />
                <Box width={contentWidth}>
                  <Box width={sourceLabel!.length} flexShrink={0}>
                    <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
                      {sourceLabel}
                    </Text>
                  </Box>
                  <Box
                    width={Math.max(1, contentWidth - sourceLabel!.length)}
                    flexDirection="column"
                  >
                    <Text
                      wrap="wrap"
                      {...colorProp(color, ZEDBEE_THEME.secondary)}
                    >
                      {source}
                    </Text>
                  </Box>
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
