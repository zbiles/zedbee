import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { PixelBee } from "../../src/ui/pixel-bee.js";

describe("PixelBee", () => {
  it("uses the same two-column cell width for transparent and filled pixels", () => {
    const frame = render(<PixelBee color={false} />).lastFrame()!;
    const firstRow = frame.split("\n")[0]!;

    expect(firstRow.indexOf("██")).toBe(6);
  });

  it("builds motion trails from the bee's square pixel cells", () => {
    const frame = render(
      <PixelBee mirrored motion color={false} />,
    ).lastFrame()!;
    const stingerRow = frame.split("\n")[7]!;

    expect(stingerRow).toMatch(/^████████ {4}████████ {4}████████ /u);
  });

  it("uses one terminal column per logical cell in the compact brand", () => {
    const frame = render(
      <PixelBee compact motion color={false} />,
    ).lastFrame()!;
    const lines = frame.split("\n");

    expect(lines[0]!.indexOf("█")).toBe(3);
    expect(lines[7]).toMatch(/^██████████ ████ {2}████ {2}████$/u);
  });
});
