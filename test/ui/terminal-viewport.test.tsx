import { waitForAssertion } from "../helpers/wait-for-assertion.js";
import { createRef } from "react";
import { Box, measureElement, Text, type DOMElement } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(cleanup);

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

async function expectSettledFrame(
  view: ReturnType<typeof render>,
  assertion: (frame: string) => void,
): Promise<void> {
  try {
    // Ink measures boxes in an effect. Let that first effect turn run before
    // checking the frame.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await waitForAssertion(() => {
      const frame = view.lastFrame();
      expect(frame).toBeDefined();
      assertion(frame!);
    });
  } finally {
    view.unmount();
    view.cleanup();
  }
}

describe("TerminalViewport", () => {
  it("uses the whole requested height without indicator rows when content fits", async () => {
    const view = viewport(12, 0);

    await waitForAssertion(() => {
      const frame = view.lastFrame()!;
      const lines = frame.split("\n");
      expect(lines).toHaveLength(12);
      expect(frame).not.toContain("MORE ABOVE");
      expect(frame).not.toContain("MORE BELOW");
      expect(lines.slice(0, 10)).toEqual(tenLines);
    });
  });

  it.each([
    [1, 0, [tenLines[0]]],
    [1, 9, [tenLines[9]]],
    [2, 0, tenLines.slice(0, 2)],
    [2, 8, tenLines.slice(8, 10)],
  ])(
    "devotes all %i short viewport rows to reachable content at offset %i",
    async (height, offset, expectedLines) => {
      const onMetricsChange =
        vi.fn<(metrics: TerminalViewportMetrics) => void>();
      const view = render(
        <TerminalViewport
          width={width}
          height={height}
          offset={offset}
          color={false}
          onOffsetChange={() => undefined}
          onMetricsChange={onMetricsChange}
        >
          <Fixture />
        </TerminalViewport>,
      );

      await waitForAssertion(() => {
        const frame = view.lastFrame()!;
        expect(frame.split("\n")).toEqual(expectedLines);
        expect(frame).not.toContain("MORE ABOVE");
        expect(frame).not.toContain("MORE BELOW");
        expect(onMetricsChange).toHaveBeenLastCalledWith({
          contentHeight: 10,
          visibleHeight: height,
        });
      });
    },
  );

  it("clips the complete child frame between stable overflow indicator rows", async () => {
    await expectSettledFrame(viewport(6, 0), (frame) => {
      const topLines = frame.split("\n");
      expect(topLines).toHaveLength(6);
      expect(frame).not.toContain("MORE ABOVE");
      expect(frame).toContain("↓ MORE BELOW");
      expect(topLines[0]).toBe("");
      expect(topLines.slice(1, 5)).toEqual(tenLines.slice(0, 4));
      expect(topLines[5]).toContain("↓ MORE BELOW");
    });

    await expectSettledFrame(viewport(6, 3), (frame) => {
      const middleLines = frame.split("\n");
      expect(middleLines).toHaveLength(6);
      expect(frame).toContain("↑ MORE ABOVE");
      expect(frame).toContain("↓ MORE BELOW");
      expect(middleLines[0]).toContain("↑ MORE ABOVE");
      expect(middleLines.slice(1, 5)).toEqual(tenLines.slice(3, 7));
      expect(middleLines[5]).toContain("↓ MORE BELOW");
    });

    await expectSettledFrame(viewport(6, 6), (frame) => {
      const bottomLines = frame.split("\n");
      expect(bottomLines).toHaveLength(6);
      expect(frame).toContain("↑ MORE ABOVE");
      expect(frame).not.toContain("MORE BELOW");
      expect(bottomLines[0]).toContain("↑ MORE ABOVE");
      expect(bottomLines.slice(1, 5)).toEqual(tenLines.slice(6, 10));
      expect(bottomLines[5]).toBe("");
    });
  });

  it("uses single-arrow indicators that stay within one row at narrow widths", async () => {
    const narrowViewport = (offset: number) =>
      render(
        <TerminalViewport
          width={11}
          height={5}
          offset={offset}
          color={false}
          onOffsetChange={() => undefined}
        >
          <Box flexDirection="column">
            {Array.from({ length: 10 }, (_, index) => (
              <Text key={index}>{`L${index + 1}`}</Text>
            ))}
          </Box>
        </TerminalViewport>,
      );
    await expectSettledFrame(narrowViewport(0), (frame) => {
      const topLines = frame.split("\n");
      expect(topLines).toHaveLength(5);
      expect(topLines[4]?.trim()).toBe("↓");
      expect(frame).not.toContain("MORE");
    });

    await expectSettledFrame(narrowViewport(3), (frame) => {
      const middleLines = frame.split("\n");
      expect(middleLines).toHaveLength(5);
      expect(middleLines[0]?.trim()).toBe("↑");
      expect(middleLines[4]?.trim()).toBe("↓");
      expect(frame).not.toContain("MORE");
    });

    await expectSettledFrame(narrowViewport(7), (frame) => {
      const bottomLines = frame.split("\n");
      expect(bottomLines).toHaveLength(5);
      expect(bottomLines[0]?.trim()).toBe("↑");
      expect(bottomLines[4]).toBe("");
      expect(frame).not.toContain("MORE");
    });
  });

  it("keeps the full content width instead of reserving a scrollbar column", async () => {
    const view = viewport(6, 0);

    await waitForAssertion(() => {
      const lines = view.lastFrame()!.split("\n");
      expect(lines[1]).toBe("01-abcdefghijklmnopq");
      expect(lines[2]).toBe("02-abcdefghijklmnopq");
      expect(lines).toHaveLength(6);
    });
  });

  it.each([
    [2, 1, 0],
    [5, 10, 1],
  ])(
    "clips an over-wide child to the public viewport width at height %i",
    async (height, contentLines, firstContentRow) => {
      const view = render(
        <TerminalViewport
          width={10}
          height={height}
          offset={0}
          color={false}
          onOffsetChange={() => undefined}
        >
          <Box width={20} flexShrink={0} flexDirection="column">
            {Array.from({ length: contentLines }, (_, index) => (
              <Text key={index}>abcdefghijklmnopqrst</Text>
            ))}
          </Box>
        </TerminalViewport>,
      );

      await waitForAssertion(() => {
        const lines = view.lastFrame()!.split("\n");
        expect(lines).toHaveLength(height);
        expect(lines[firstContentRow]).toBe("abcdefghij");
        expect(lines.every((line) => line.length <= 10)).toBe(true);
        if (contentLines > height) expect(lines[height - 1]?.trim()).toBe("↓");
      });
    },
  );

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
    await waitForAssertion(() =>
      expect(onOffsetChange).toHaveBeenLastCalledWith(4),
    );

    view.rerender(viewFor(12, 12));
    await waitForAssertion(() => {
      expect(onOffsetChange).toHaveBeenLastCalledWith(0);
      expect(view.lastFrame()).not.toContain("MORE ABOVE");
      expect(view.lastFrame()).not.toContain("MORE BELOW");
    });

    onOffsetChange.mockClear();
    view.rerender(viewFor(5, 12));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onOffsetChange).not.toHaveBeenCalled();

    view.rerender(viewFor(5, 6));
    await waitForAssertion(() =>
      expect(onOffsetChange).toHaveBeenLastCalledWith(3),
    );
  });

  it("deduplicates a clamp request across rerenders until the offset catches up", async () => {
    const requests: number[] = [];
    const viewFor = (height: number, offset: number) => (
      <TerminalViewport
        width={width}
        height={height}
        offset={offset}
        color={false}
        onOffsetChange={(nextOffset) => requests.push(nextOffset)}
      >
        <Fixture />
      </TerminalViewport>
    );
    const view = render(viewFor(6, 99));

    await waitForAssertion(() => expect(requests).toEqual([6]));

    view.rerender(viewFor(6, 99));
    view.rerender(viewFor(6, 99));
    view.rerender(viewFor(6, 99));
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toEqual([6]);

    view.rerender(viewFor(5, 99));
    await waitForAssertion(() => expect(requests).toEqual([6, 7]));

    view.rerender(viewFor(5, 7));
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toEqual([6, 7]);

    view.rerender(viewFor(5, 99));
    await waitForAssertion(() => expect(requests).toEqual([6, 7, 7]));
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

    await waitForAssertion(() => {
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
    await waitForAssertion(() =>
      expect(onMetricsChange).toHaveBeenLastCalledWith({
        contentHeight: 10,
        visibleHeight: 12,
      }),
    );
  });
});
