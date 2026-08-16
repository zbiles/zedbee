import { Box, Text } from "ink";
import type { Finding } from "../core/types.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

function severityColor(finding: Finding): string {
  return finding.severity === "error" ? ZEDBEE_THEME.failure : ZEDBEE_THEME.warning;
}

export function FindingsList({
  findings,
  width,
  color
}: {
  findings: readonly Finding[];
  width: number;
  color: boolean;
}) {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const file = finding.location?.file ?? "Repository";
    const group = groups.get(file) ?? [];
    group.push(finding);
    groups.set(file, group);
  }

  return (
    <Box flexDirection="column" width={width}>
      {[...groups].map(([file, group]) => (
        <Box key={file} flexDirection="column" marginTop={1}>
          <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
            {file}
          </Text>
          {group.map((finding) => (
            <Box key={finding.id} flexDirection="column" marginLeft={2}>
              <Text {...colorProp(color, severityColor(finding))}>
                {finding.location?.startLine ?? 1}:{finding.location?.startColumn ?? 1}{"  "}
                {finding.severity.toUpperCase()}  {finding.check}/{finding.rule}
              </Text>
              <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.primary)}>
                {finding.message}
              </Text>
              {finding.remediation === undefined ? null : (
                <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
                  Fix: {finding.remediation}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
