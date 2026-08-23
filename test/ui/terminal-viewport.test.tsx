import { createRef } from "react";
import { Box, measureElement, Text, type DOMElement } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  TerminalViewport,
  type TerminalViewportMetrics,
} from "../../src/ui/terminal-viewport.js";

const width = 20;
const tenLines = [
  "01-abcdefghijklmnopq",
  "02-abcdefghijklmnopq",
  "03-abcdefghijklmnopq",
  "04-abcdefghijklmnopq",
  "05-abcdefghijklmnopq",
  "06-abcdefghijklmnopq",
  "07-abcdefghijklmnopq",
  "08-abcdefghijklmnopq",
  "09-abcdefghijklmnopq",
  "10-abcdefghijklmnopq",
] as const;

function Fixture({ count = tenLines.length }: { readonly count?: number }) {
  return (
    <Box flexDirection="column">
      {Array.from({ length: count }, (_, index) => (
        <Text
          key={index}
        >{`${String(index + 1).padStart(2, "0")}-abcdefghijklmnopq`}</Text>
      ))}
    </Box>
  );
}

function viewport(height: number, offset: number) {
  return render(
    <TerminalViewport
      width={width}
      height={height}
      offset={offset}
      color={false}
      onOffsetChange={() => undefined}
    >
      <Fixture />
    </TerminalViewport>,
  );
}

describe("TerminalViewport", () => {
  it("uses the whole requested height without indicator rows when content fits", async () => {
    const view = viewport(12, 0);

    await vi.waitFor(() => {
      const frame = view.lastFrame()!;
      const lines = frame.split("\n");
      expect(lines).toHaveLength(12);
      expect(frame).not.toContain("MORE ABOVE");
      expect(frame).not.toContain("MORE BELOW");
      expect(lines.slice(0, 10)).toEqual(tenLines);
    });
  });

  it("clips the complete child frame between stable overflow indicator rows", async () => {
    const top = viewport(6, 0);
    const middle = viewport(6, 3);
    const bottom = viewport(6, 6);

    await vi.waitFor(() => {
      const topLines = top.lastFrame()!.split("\n");
      const middleLines = middle.lastFrame()!.split("\n");
      const bottomLines = bottom.lastFrame()!.split("\n");

      expect(topLines).toHaveLength(6);
      expect(middleLines).toHaveLength(6);
      expect(bottomLines).toHaveLength(6);

      expect(top.lastFrame()).not.toContain("MORE ABOVE");
      expect(top.lastFrame()).toContain("↓ MORE BELOW");
      expect(topLines[0]).toBe("");
      expect(topLines.slice(1, 5)).toEqual(tenLines.slice(0, 4));
      expect(topLines[5]).toContain("↓ MORE BELOW");

      expect(middle.lastFrame()).toContain("↑ MORE ABOVE");
      expect(middle.lastFrame()).toContain("↓ MORE BELOW");
      expect(middleLines[0]).toContain("↑ MORE ABOVE");
      expect(middleLines.slice(1, 5)).toEqual(tenLines.slice(3, 7));
      expect(middleLines[5]).toContain("↓ MORE BELOW");

      expect(bottom.lastFrame()).toContain("↑ MORE ABOVE");
      expect(bottom.lastFrame()).not.toContain("MORE BELOW");
      expect(bottomLines[0]).toContain("↑ MORE ABOVE");
      expect(bottomLines.slice(1, 5)).toEqual(tenLines.slice(6, 10));
      expect(bottomLines[5]).toBe("");
    });
  });

  it("keeps the full content width instead of reserving a scrollbar column", async () => {
    const view = viewport(6, 0);

    await vi.waitFor(() => {
      const lines = view.lastFrame()!.split("\n");
      expect(lines[1]).toBe("01-abcdefghijklmnopq");
      expect(lines[2]).toBe("02-abcdefghijklmnopq");
      expect(lines).toHaveLength(6);
    });
  });

  it("requests a newly clamped offset when the viewport or content changes", async () => {
    const onOffsetChange = vi.fn<(offset: number) => void>();
    const viewFor = (height: number, count: number) => (
      <TerminalViewport
        width={width}
        height={height}
        offset={8}
        color={false}
        onOffsetChange={onOffsetChange}
      >
        <Fixture count={count} />
      </TerminalViewport>
    );
    const view = render(viewFor(5, 12));

    await new Promise((resolve) => setImmediate(resolve));
    expect(onOffsetChange).not.toHaveBeenCalled();

    view.rerender(viewFor(10, 12));
    await vi.waitFor(() => expect(onOffsetChange).toHaveBeenLastCalledWith(4));

    view.rerender(viewFor(12, 12));
    await vi.waitFor(() => {
      expect(onOffsetChange).toHaveBeenLastCalledWith(0);
      expect(view.lastFrame()).not.toContain("MORE ABOVE");
      expect(view.lastFrame()).not.toContain("MORE BELOW");
    });

    onOffsetChange.mockClear();
    view.rerender(viewFor(5, 12));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onOffsetChange).not.toHaveBeenCalled();

    view.rerender(viewFor(5, 6));
    await vi.waitFor(() => expect(onOffsetChange).toHaveBeenLastCalledWith(3));
  });

  it("reports changed metrics and exposes the measured content element", async () => {
    const contentRef = createRef<DOMElement>();
    const onMetricsChange = vi.fn<(metrics: TerminalViewportMetrics) => void>();
    const viewFor = (height: number) => (
      <TerminalViewport
        width={width}
        height={height}
        offset={0}
        color={false}
        contentRef={contentRef}
        onOffsetChange={() => undefined}
        onMetricsChange={onMetricsChange}
      >
        <Fixture />
      </TerminalViewport>
    );
    const view = render(viewFor(6));

    await vi.waitFor(() => {
      expect(contentRef.current).not.toBeNull();
      expect(measureElement(contentRef.current!)).toMatchObject({
        width,
        height: 10,
      });
      expect(onMetricsChange).toHaveBeenLastCalledWith({
        contentHeight: 10,
        visibleHeight: 4,
      });
    });
    const callsAfterMeasurement = onMetricsChange.mock.calls.length;

    view.rerender(viewFor(6));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMetricsChange).toHaveBeenCalledTimes(callsAfterMeasurement);

    view.rerender(viewFor(12));
    await vi.waitFor(() =>
      expect(onMetricsChange).toHaveBeenLastCalledWith({
        contentHeight: 10,
        visibleHeight: 12,
      }),
    );
  });
});
