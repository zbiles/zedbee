import { describe, expect, it } from "vitest";
import {
  clampScrollOffset,
  minimalRevealOffset,
  pageScrollStep,
  parseSgrWheelDelta,
} from "../../src/ui/terminal-viewport-model.js";

describe("terminal viewport model", () => {
  it.each([
    [-4, 30, 10, 0],
    [7, 30, 10, 7],
    [99, 30, 10, 20],
    [8, 6, 10, 0],
  ])("clamps %i for content=%i viewport=%i", (offset, content, viewport, expected) => {
    expect(clampScrollOffset(offset, content, viewport)).toBe(expected);
  });

  it("does not move when the target is already fully visible", () => {
    expect(minimalRevealOffset(8, 12, 10, 2, 40)).toBe(8);
  });

  it("moves only enough to reveal a clipped target above or below", () => {
    expect(minimalRevealOffset(8, 12, 6, 1, 40)).toBe(6);
    expect(minimalRevealOffset(8, 12, 20, 2, 40)).toBe(10);
  });

  it("clamps an oversized target to its leading edge", () => {
    expect(minimalRevealOffset(0, 5, 9, 8, 30)).toBe(9);
  });

  it.each([[1, 1], [2, 1], [10, 8]])(
    "uses a two-row page overlap for height %i",
    (height, expected) => expect(pageScrollStep(height)).toBe(expected),
  );

  it.each([
    ["[<64;20;8M", -3],
    ["[<65;20;8M", 3],
    ["\u001b[<64;20;8M", -3],
    ["[<0;20;8M", 0],
    ["[<32;20;8M", 0],
    ["plain input", 0],
  ])("parses %j as %i rows", (input, expected) => {
    expect(parseSgrWheelDelta(input)).toBe(expected);
  });

  it("sums wheel events in concatenated input and ignores non-wheel events", () => {
    expect(parseSgrWheelDelta("\u001b[<64;20;8M[<65;20;8M[<0;20;8M")).toBe(0);
  });
});
