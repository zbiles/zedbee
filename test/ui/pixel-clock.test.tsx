import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { PixelClock } from "../../src/ui/pixel-clock.js";

describe("PixelClock", () => {
  it("renders multi-digit summary counts at the full three-row height", () => {
    const frame = render(<PixelClock value="10" color={false} />).lastFrame()!;
    const lines = frame.split("\n");

    expect(lines).toEqual(["▄█  █▀█", " █  █ █", "▀▀▀ ▀▀▀"]);
  });
});
