import { Box, Text, render } from "ink";
import type { Diagnostic } from "../doctor/diagnostics.js";
import { PixelBee, pixelBeeWidth } from "./pixel-bee.js";
import { PixelWordmark, pixelWordmarkWidth } from "./pixel-wordmark.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

function diagnosticTone(status: Diagnostic["status"]): string {
  if (status === "pass") return ZEDBEE_THEME.pass;
  if (status === "warning") return ZEDBEE_THEME.warning;
  return ZEDBEE_THEME.failure;
}

function diagnosticIcon(status: Diagnostic["status"]): string {
  if (status === "pass") return "✓";
  if (status === "warning") return "!";
  return "×";
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

function DoctorPanel({
  diagnostics,
  width,
  color,
}: {
  diagnostics: readonly Diagnostic[];
  width: number;
  color: boolean;
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
        <Text {...colorProp(color, ZEDBEE_THEME.muted)}>DOCTOR</Text>
      </Box>
      <HorizontalRule width={width} color={color} />
      {diagnostics.map((diagnostic, index) => {
        const tone = diagnosticTone(diagnostic.status);
        return (
          <Box key={diagnostic.id} flexDirection="column">
            <Box paddingX={2}>
              <Box width={3} flexShrink={0} justifyContent="center">
                <Text bold {...colorProp(color, tone)}>
                  {diagnosticIcon(diagnostic.status)}
                </Text>
              </Box>
              <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
                {diagnostic.id}
              </Text>
              <Box flexGrow={1} minWidth={1}>
                <Text> </Text>
              </Box>
              <Text bold {...colorProp(color, tone)}>
                {diagnostic.status.toUpperCase()}
              </Text>
            </Box>
            <Box paddingLeft={5} paddingRight={2}>
              <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
                {diagnostic.message}
              </Text>
            </Box>
            {diagnostic.remediation === undefined ? null : (
              <Box paddingLeft={5} paddingRight={2}>
                <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
                  Remediation: {diagnostic.remediation}
                </Text>
              </Box>
            )}
            {index < diagnostics.length - 1 ? (
              <HorizontalRule width={width} color={color} />
            ) : null}
          </Box>
        );
      })}
      <Text> </Text>
    </Box>
  );
}

export function DoctorDashboard({
  diagnostics,
  width,
  color,
}: {
  diagnostics: readonly Diagnostic[];
  width: number;
  color: boolean;
}) {
  const frameWidth = Math.max(1, width - 2);
  const compactBrand = width < 129;
  const brandWidth = pixelWordmarkWidth(compactBrand);
  const brandGroupWidth = brandWidth + 2 + pixelBeeWidth(compactBrand);
  const contentWidth = Math.max(1, frameWidth - 7);
  const solidBorder = {
    top: "█",
    bottom: "█",
    left: "█",
    right: "█",
    topLeft: "█",
    topRight: "█",
    bottomLeft: "█",
    bottomRight: "█",
  };
  const dashboard = (
    <Box width={frameWidth} {...(color ? { backgroundColor: "#000000" } : {})}>
      <Box
        flexDirection="column"
        width={frameWidth}
        borderStyle={solidBorder}
        {...(color ? { borderColor: ZEDBEE_THEME.yellow } : {})}
        borderBackgroundColor="#000000"
      >
        <Box
          flexDirection="column"
          width={frameWidth - 2}
          borderStyle={solidBorder}
          borderTop={false}
          borderBottom={false}
          {...(color ? { borderColor: ZEDBEE_THEME.yellow } : {})}
          paddingLeft={2}
          paddingRight={1}
          paddingBottom={1}
        >
          <Box
            height={5}
            justifyContent="center"
            marginTop={2}
            marginBottom={2}
          >
            <Box position="relative" width={brandGroupWidth} height={5}>
              <PixelWordmark color={color} compact={compactBrand} />
              <Box position="absolute" left={brandWidth + 2} top={-5}>
                <PixelBee compact={compactBrand} sparse color={color} />
              </Box>
            </Box>
          </Box>
          <DoctorPanel
            diagnostics={diagnostics}
            width={contentWidth}
            color={color}
          />
        </Box>
      </Box>
    </Box>
  );
  return (
    <Box width={width} paddingLeft={1} paddingRight={1} paddingTop={2}>
      {dashboard}
    </Box>
  );
}

export async function runInkDoctor(
  diagnostics: readonly Diagnostic[],
  options: { readonly width: number; readonly color: boolean },
): Promise<void> {
  const app = render(
    <DoctorDashboard diagnostics={diagnostics} {...options} />,
    { exitOnCtrlC: false, patchConsole: false, maxFps: 1 },
  );
  try {
    await app.waitUntilRenderFlush();
  } finally {
    app.unmount();
    await app.waitUntilExit();
  }
}
