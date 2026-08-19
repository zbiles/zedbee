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
const TEXT_GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  P: ["111", "101", "111", "100", "100"],
  A: ["111", "101", "111", "101", "101"],
  S: ["111", "100", "111", "001", "111"],
  F: ["111", "100", "111", "100", "100"],
  I: ["111", "010", "010", "010", "111"],
  L: ["100", "100", "100", "100", "111"],
  W: ["101", "101", "101", "111", "101"],
  R: ["111", "101", "110", "101", "101"],
  N: ["111", "101", "101", "101", "101"],
});

export type PixelLabel = "pass" | "warn" | "fail";

const PIXEL_LABELS: ReadonlySet<string> = new Set<PixelLabel>([
  "pass",
  "warn",
  "fail",
]);

function halfBlock(top: string, bottom: string): string {
  if (top === "1" && bottom === "1") return "█";
  if (top === "1") return "▀";
  if (bottom === "1") return "▄";
  return " ";
}

function renderPixelRows(
  value: string,
  glyphs: Readonly<Record<string, readonly string[]>>,
  fallback: readonly string[],
): string[] {
  const rows = [...value].map(
    (character) => glyphs[character.toUpperCase()] ?? fallback,
  );
  return [0, 2, 4].map((topRow) =>
    rows
      .map((glyph) =>
        [...(glyph[topRow] ?? "000")]
          .map((top, column) =>
            halfBlock(top, glyph[topRow + 1]?.[column] ?? "0"),
          )
          .join(""),
      )
      .join(" "),
  );
}

export function pixelClockWidth(value: string): number {
  return Math.max(0, value.length * 4 - 1);
}

export function pixelClockRows(value: string): string[] {
  return renderPixelRows(value, GLYPHS, GLYPHS["0"]!);
}

export function pixelTextRows(value: PixelLabel): string[] {
  if (!PIXEL_LABELS.has(value)) {
    throw new Error(`Unsupported pixel label "${value}".`);
  }

  return renderPixelRows(value, TEXT_GLYPHS, TEXT_GLYPHS.P!);
}

export function PixelClock({
  value,
  color,
  tone = ZEDBEE_THEME.primary,
}: {
  value: string;
  color: boolean;
  tone?: string;
}) {
  return (
    <Text bold {...colorProp(color, tone)}>
      {pixelClockRows(value).join("\n")}
    </Text>
  );
}
