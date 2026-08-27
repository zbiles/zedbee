import { Box, Text } from "ink";
import { colorProp, ZEDBEE_THEME } from "./theme.js";
import { halfBlockGlyph, pairPixelRows } from "./compact-pixels.js";

const LETTERS = Object.freeze({
  Z: ["11111", "00001", "11111", "10000", "11111"],
  E: ["11111", "10000", "11110", "10000", "11111"],
  D: ["11110", "10011", "10001", "10001", "11111"],
  B: ["11110", "10001", "11110", "10001", "11110"],
  S: ["11111", "10000", "11111", "00001", "11111"],
  W: ["10001", "10101", "11111", "01110", "01010"],
  A: ["11111", "10001", "11111", "10001", "10001"],
  R: ["11111", "10001", "11111", "10010", "10010"],
  M: ["11111", "10101", "10101", "10001", "10001"],
});

const ZEDBEE = ["Z", "E", "D", "B", "E", "E"] as const;
const SWARM = ["S", "W", "A", "R", "M"] as const;

const ZEDBEE_GRID = Object.freeze(
  Array.from({ length: 5 }, (_, row) =>
    ZEDBEE.map((letter) => LETTERS[letter][row]).join("0"),
  ),
);
const SWARM_GRID = Object.freeze(
  Array.from(
    { length: 5 },
    (_, row) =>
      "000000" + SWARM.map((letter) => LETTERS[letter][row]).join("0"),
  ),
);

export const WORDMARK_GRID = Object.freeze([
  ...ZEDBEE_GRID,
  "0".repeat(ZEDBEE_GRID[0]!.length),
  ...SWARM_GRID,
]);

export function pixelWordmarkWidth(compact: boolean): number {
  return WORDMARK_GRID[0]!.length * (compact ? 1 : 2);
}

export function pixelWordmarkHeight(compact: boolean): number {
  return compact ? Math.ceil(WORDMARK_GRID.length / 2) : WORDMARK_GRID.length;
}

export function PlainWordmark({ color }: { color: boolean }) {
  return (
    <Box flexDirection="column" height={3}>
      <Text bold {...colorProp(color, ZEDBEE_THEME.wordmark)}>
        ZEDBEE
      </Text>
      <Text> </Text>
      <Text bold {...colorProp(color, ZEDBEE_THEME.yellow)}>
        {" SWARM"}
      </Text>
    </Box>
  );
}

export function PixelWordmark({
  color,
  compact = false,
}: {
  color: boolean;
  compact?: boolean;
}) {
  const renderGrid = (grid: readonly string[]) =>
    compact
      ? pairPixelRows(grid)
          .map((row) =>
            row
              .map(({ top, bottom }) =>
                halfBlockGlyph(top === "1", bottom === "1"),
              )
              .join(""),
          )
          .join("\n")
      : grid
          .map((row) =>
            [...row].map((pixel) => (pixel === "1" ? "██" : "  ")).join(""),
          )
          .join("\n");
  const swarmTop = compact ? 3 : 6;

  return (
    <Box
      position="relative"
      width={pixelWordmarkWidth(compact)}
      height={pixelWordmarkHeight(compact)}
    >
      <Box position="absolute" top={0} left={0}>
        <Text {...colorProp(color, ZEDBEE_THEME.wordmark)}>
          {renderGrid(ZEDBEE_GRID)}
        </Text>
      </Box>
      <Box position="absolute" top={swarmTop} left={0}>
        <Text {...colorProp(color, ZEDBEE_THEME.yellow)}>
          {renderGrid(SWARM_GRID)}
        </Text>
      </Box>
    </Box>
  );
}
