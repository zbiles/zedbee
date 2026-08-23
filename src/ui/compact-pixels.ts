export interface PixelPair {
  readonly top: string;
  readonly bottom: string;
}

export function halfBlockGlyph(
  topFilled: boolean,
  bottomFilled: boolean,
): " " | "▀" | "▄" | "█" {
  if (topFilled && bottomFilled) return "█";
  if (topFilled) return "▀";
  if (bottomFilled) return "▄";
  return " ";
}

export function pairPixelRows(
  rows: readonly string[],
): readonly (readonly PixelPair[])[] {
  const width = rows[0]?.length ?? 0;
  if (rows.some((row) => row.length !== width)) {
    throw new Error("Pixel rows must have equal widths.");
  }
  return Object.freeze(
    Array.from({ length: Math.ceil(rows.length / 2) }, (_, pairIndex) => {
      const top = rows[pairIndex * 2]!;
      const bottom = rows[pairIndex * 2 + 1] ?? "0".repeat(width);
      return Object.freeze(
        Array.from({ length: width }, (_, column) =>
          Object.freeze({ top: top[column]!, bottom: bottom[column]! }),
        ),
      );
    }),
  );
}
