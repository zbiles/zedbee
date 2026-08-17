import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { LiveDashboard } from "../../src/ui/live-dashboard.js";

describe("PixelClock", () => {
  it("keeps the small seconds suffix on the numeric clock baseline", () => {
    const frame = render(
      <LiveDashboard
        events={[]}
        startedAt={0}
        elapsedMs={2800}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    const lines = frame.split("\n");
    const summaryTop = lines.findIndex((line) => line.includes("SUMMARY")) - 1;
    const firstClockRow = lines.findIndex((line) => line.includes("▀▀█"));
    const lastClockRow = lines.findIndex((line) =>
      line.includes("▀▀▀  ▀  ▀▀▀"),
    );
    const summaryRightStroke = lines[summaryTop]!.lastIndexOf("┐");
    const elapsedRight =
      lines[lastClockRow]!.indexOf("elapsed") + "elapsed".length - 1;
    const clockLines = lines.slice(firstClockRow, lastClockRow + 1);

    expect(summaryTop).toBeGreaterThanOrEqual(0);
    expect(firstClockRow).toBeGreaterThan(summaryTop);
    expect(lastClockRow - firstClockRow).toBe(2);
    expect(clockLines[0]).not.toContain("s");
    expect(clockLines[1]).not.toContain("s");
    expect(clockLines[2]).toContain("▀▀▀  ▀  ▀▀▀s");
    expect(
      `${clockLines[0]}${clockLines[1]}${clockLines[2]!.slice(
        0,
        clockLines[2]!.indexOf("elapsed"),
      )}`.match(/s/gu),
    ).toHaveLength(1);
    expect(elapsedRight).toBe(87);
    expect(summaryRightStroke - elapsedRight).toBe(3);
  });
});
