import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { PixelClock, pixelTextRows } from "../../src/ui/pixel-clock.js";

describe("PixelClock", () => {
  it("renders multi-digit summary counts at the full three-row height", () => {
    const frame = render(<PixelClock value="10" color={false} />).lastFrame()!;
    const lines = frame.split("\n");

    expect(lines).toEqual(["▄█  █▀█", " █  █ █", "▀▀▀ ▀▀▀"]);
  });

  it("rejects text outside the three supported summary labels clearly", () => {
    expect(() =>
      pixelTextRows("zed" as Parameters<typeof pixelTextRows>[0]),
    ).toThrowError('Unsupported pixel label "zed".');
  });
});
