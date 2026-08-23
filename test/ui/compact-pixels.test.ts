import { describe, expect, it } from "vitest";
import {
  halfBlockGlyph,
  pairPixelRows,
} from "../../src/ui/compact-pixels.js";

describe("compact pixels", () => {
  it.each([
    [false, false, " "],
    [true, false, "▀"],
    [false, true, "▄"],
    [true, true, "█"],
  ] as const)("maps top=%s bottom=%s to %s", (top, bottom, glyph) => {
    expect(halfBlockGlyph(top, bottom)).toBe(glyph);
  });

  it("pairs rows and supplies an empty lower half for an odd final row", () => {
    expect(pairPixelRows(["ab", "cd", "ef"])).toEqual([
      [
        { top: "a", bottom: "c" },
        { top: "b", bottom: "d" },
      ],
      [
        { top: "e", bottom: "0" },
        { top: "f", bottom: "0" },
      ],
    ]);
  });

  it("rejects source rows with inconsistent widths", () => {
    expect(() => pairPixelRows(["00", "0"])).toThrow(
      "Pixel rows must have equal widths.",
    );
  });
});
