import { Box, Text } from "ink";
import { BEE_GRID, mirrorBee, motionDashGrid } from "./bee-grid.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

type Pixel = "0" | "w" | "y" | "b";

function pixelColor(pixel: Pixel): string {
  if (pixel === "w") {
    return ZEDBEE_THEME.wing;
  }
  if (pixel === "y") {
    return ZEDBEE_THEME.yellow;
  }
  return ZEDBEE_THEME.beeBlack;
}

function PixelRow({
  row,
  color,
  compact,
}: {
  row: string;
  color: boolean;
  compact: boolean;
}) {
  const empty = compact ? " " : "  ";
  const filled = compact ? "█" : "██";
  return (
    <Text>
      {[...row].map((pixel, index) =>
        pixel === "0" ? (
          <Text key={index}>{empty}</Text>
        ) : (
          <Text key={index} {...colorProp(color, pixelColor(pixel as Pixel))}>
            {filled}
          </Text>
        ),
      )}
    </Text>
  );
}

export function PixelBee({
  mirrored = false,
  motion = false,
  motionPixel = "y",
  compact = false,
  color = true,
}: {
  mirrored?: boolean;
  motion?: boolean;
  motionPixel?: "y" | "w";
  compact?: boolean;
  color?: boolean;
}) {
  const bee = mirrored ? mirrorBee(BEE_GRID) : [...BEE_GRID];
  const dashes = motionDashGrid(motionPixel);

  return (
    <Box flexDirection="column">
      {bee.map((row, index) => (
        <Box key={index} flexDirection="row">
          {motion && mirrored ? (
            <PixelRow row={dashes[index]!} color={color} compact={compact} />
          ) : null}
          {motion && mirrored ? <Text> </Text> : null}
          <PixelRow row={row} color={color} compact={compact} />
          {motion && !mirrored ? <Text> </Text> : null}
          {motion && !mirrored ? (
            <PixelRow row={dashes[index]!} color={color} compact={compact} />
          ) : null}
        </Box>
      ))}
    </Box>
  );
}
