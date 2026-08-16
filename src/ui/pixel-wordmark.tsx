import { Text } from "ink";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

const LETTERS = Object.freeze({
  Z: ["11111", "00001", "11111", "10000", "11111"],
  E: ["11111", "10000", "11110", "10000", "11111"],
  D: ["11110", "10011", "10001", "10001", "11111"],
  B: ["11110", "10001", "11110", "10001", "11110"],
});

const WORD = ["Z", "E", "D", "B", "E", "E"] as const;

export const WORDMARK_GRID = Object.freeze(
  Array.from({ length: 5 }, (_, row) =>
    WORD.map((letter) => LETTERS[letter][row]).join("0"),
  ),
);

export function PixelWordmark({
  color,
  compact = false,
}: {
  color: boolean;
  compact?: boolean;
}) {
  const filled = compact ? "█" : "██";
  const empty = compact ? " " : "  ";
  return (
    <Text {...colorProp(color, ZEDBEE_THEME.wordmark)}>
      {WORDMARK_GRID.map((row) =>
        [...row].map((pixel) => (pixel === "1" ? filled : empty)).join(""),
      ).join("\n")}
    </Text>
  );
}
