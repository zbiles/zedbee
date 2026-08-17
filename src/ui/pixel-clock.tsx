import { Text } from "ink";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

const GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  ".": ["000", "000", "000", "000", "010"],
});

function halfBlock(top: string, bottom: string): string {
  if (top === "1" && bottom === "1") return "█";
  if (top === "1") return "▀";
  if (bottom === "1") return "▄";
  return " ";
}

export function pixelClockWidth(value: string): number {
  return Math.max(0, value.length * 4 - 1);
}

function clockRows(value: string): string[] {
  const glyphs = [...value].map(
    (character) => GLYPHS[character] ?? GLYPHS["0"]!,
  );
  return [0, 2, 4].map((topRow) =>
    glyphs
      .map((glyph) =>
        [...glyph[topRow]!]
          .map((top, column) =>
            halfBlock(top, glyph[topRow + 1]?.[column] ?? "0"),
          )
          .join(""),
      )
      .join(" "),
  );
}

export function PixelClock({
  value,
  color,
}: {
  value: string;
  color: boolean;
}) {
  return (
    <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
      {clockRows(value).join("\n")}
    </Text>
  );
}
