import { Box, Text } from "ink";
import { BEE_GRID, mirrorBee, motionDashGrid } from "./bee-grid.js";
import {
  halfBlockGlyph,
  pairPixelRows,
  type PixelPair,
} from "./compact-pixels.js";
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

export function pixelBeeWidth(compact: boolean): number {
  return BEE_GRID[0]!.length * (compact ? 1 : 2);
}

export function pixelBeeHeight(compact: boolean): number {
  return compact ? Math.ceil(BEE_GRID.length / 2) : BEE_GRID.length;
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

function CompactPixel({
  top,
  bottom,
  color,
}: PixelPair & {
  color: boolean;
}) {
  const foreground = top !== "0" ? top : bottom;
  const mixed = top !== "0" && bottom !== "0" && top !== bottom;
  const glyph =
    color && mixed ? "▀" : halfBlockGlyph(top !== "0", bottom !== "0");
  return (
    <Text
      {...(color && foreground !== "0"
        ? { color: pixelColor(foreground as Pixel) }
        : {})}
      {...(color && mixed
        ? { backgroundColor: pixelColor(bottom as Pixel) }
        : {})}
    >
      {glyph}
    </Text>
  );
}

function SparsePixels({
  rows,
  left,
  color,
  compact,
}: {
  rows: readonly string[];
  left: number;
  color: boolean;
  compact: boolean;
}) {
  const cellWidth = compact ? 1 : 2;
  const filled = compact ? "█" : "██";
  return rows.flatMap((row, rowIndex) =>
    [...row].flatMap((pixel, columnIndex) =>
      pixel === "0" ? (
        []
      ) : (
        <Box
          key={`${rowIndex}-${columnIndex}`}
          position="absolute"
          left={left + columnIndex * cellWidth}
          top={rowIndex}
        >
          <Text {...colorProp(color, pixelColor(pixel as Pixel))}>
            {filled}
          </Text>
        </Box>
      ),
    ),
  );
}

function CompactSparsePixels({
  rows,
  left,
  color,
}: {
  rows: readonly string[];
  left: number;
  color: boolean;
}) {
  return pairPixelRows(rows).flatMap((pairs, pairIndex) =>
    pairs.flatMap(({ top, bottom }, columnIndex) =>
      top === "0" && bottom === "0" ? (
        []
      ) : (
        <Box
          key={`${pairIndex}-${columnIndex}`}
          position="absolute"
          left={left + columnIndex}
          top={pairIndex}
        >
          <CompactPixel top={top} bottom={bottom} color={color} />
        </Box>
      ),
    ),
  );
}

export function PixelBee({
  mirrored = false,
  motion = false,
  motionPixel = "y",
  compact = false,
  sparse = false,
  color = true,
}: {
  mirrored?: boolean;
  motion?: boolean;
  motionPixel?: "y" | "w";
  compact?: boolean;
  sparse?: boolean;
  color?: boolean;
}) {
  const bee = mirrored ? mirrorBee(BEE_GRID) : [...BEE_GRID];
  const dashes = motionDashGrid(motionPixel);
  const cellWidth = compact ? 1 : 2;
  const beeWidth = pixelBeeWidth(compact);
  const dashWidth = dashes[0]!.length * cellWidth;
  const motionGap = 1;

  if (sparse) {
    const beeLeft = motion && mirrored ? dashWidth + motionGap : 0;
    const dashLeft = mirrored ? 0 : beeWidth + motionGap;
    return (
      <Box
        position="relative"
        width={beeWidth + (motion ? motionGap + dashWidth : 0)}
        height={pixelBeeHeight(compact)}
      >
        {compact ? (
          <CompactSparsePixels rows={bee} left={beeLeft} color={color} />
        ) : (
          <SparsePixels
            rows={bee}
            left={beeLeft}
            color={color}
            compact={compact}
          />
        )}
        {motion ? (
          compact ? (
            <CompactSparsePixels rows={dashes} left={dashLeft} color={color} />
          ) : (
            <SparsePixels
              rows={dashes}
              left={dashLeft}
              color={color}
              compact={compact}
            />
          )
        ) : null}
      </Box>
    );
  }

  if (compact) {
    const pairedBee = pairPixelRows(bee);
    const pairedDashes = pairPixelRows(dashes);
    return (
      <Box flexDirection="column">
        {pairedBee.map((pairs, pairIndex) => (
          <Box key={pairIndex} flexDirection="row">
            {motion && mirrored
              ? pairedDashes[pairIndex]!.map(({ top, bottom }, columnIndex) => (
                  <CompactPixel
                    key={`dash-${columnIndex}`}
                    top={top}
                    bottom={bottom}
                    color={color}
                  />
                ))
              : null}
            {motion && mirrored ? <Text> </Text> : null}
            {pairs.map(({ top, bottom }, columnIndex) => (
              <CompactPixel
                key={`bee-${columnIndex}`}
                top={top}
                bottom={bottom}
                color={color}
              />
            ))}
            {motion && !mirrored ? <Text> </Text> : null}
            {motion && !mirrored
              ? pairedDashes[pairIndex]!.map(({ top, bottom }, columnIndex) => (
                  <CompactPixel
                    key={`dash-${columnIndex}`}
                    top={top}
                    bottom={bottom}
                    color={color}
                  />
                ))
              : null}
          </Box>
        ))}
      </Box>
    );
  }

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
