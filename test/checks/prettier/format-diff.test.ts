import { Worker } from "node:worker_threads";
import * as diff from "diff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formattingTransformationRanges } from "../../../src/checks/prettier/format-diff.js";
import {
  mergeLineRanges,
  type LineRange,
} from "../../../src/git/change-set.js";

vi.mock("diff", { spy: true });

// Preserve the former jsdiff-based attribution as an independent oracle.
function originalRanges(source: string, formatted: string): LineRange[] {
  const sourceLines = Math.max(
    1,
    source.split("\n").length - Number(source.endsWith("\n")),
  );
  const ranges: LineRange[] = [];
  let line = 1;
  let removed = false;
  for (const change of diff.diffLines(source, formatted)) {
    if (change.removed) {
      ranges.push({ start: line, end: line + change.count - 1 });
      line += change.count;
      removed = true;
    } else if (change.added) {
      if (!removed)
        ranges.push({
          start: Math.min(line, sourceLines),
          end: Math.min(line, sourceLines),
        });
      removed = false;
    } else {
      line += change.count;
      removed = false;
    }
  }
  return mergeLineRanges(ranges);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("formattingTransformationRanges", () => {
  it("does not run a quadratic diff for a fully reformatted catalog", async () => {
    const entries = Array.from(
      { length: 8_000 },
      (_, index) => `"item${index}":${index}`,
    );
    const source = `{\n${entries.join(",\n")}\n}\n`;
    const formatted = `{\n${entries.map((line) => `  ${line.replace(":", ": ")}`).join(",\n")}\n}\n`;
    const compare = vi.mocked(diff.diffLines);

    expect(await formattingTransformationRanges(source, formatted)).toEqual([
      { start: 2, end: 8001 },
    ]);
    expect(compare).not.toHaveBeenCalled();
  });

  it("keeps the original attribution when repeated suffix lines are ambiguous", async () => {
    expect(
      await formattingTransformationRanges("a\nb\na\n", "a\na\nc\na\n"),
    ).toEqual([{ start: 2, end: 3 }]);
  });

  it("matches the original comparison for every short repeated-line input", async () => {
    const inputs = [""];
    let previous = [""];
    for (let length = 1; length <= 4; length++) {
      previous = previous.flatMap((prefix) =>
        ["a\n", "b\n", "\n"].map((line) => prefix + line),
      );
      inputs.push(...previous);
    }
    for (const source of inputs) {
      for (const formatted of inputs) {
        expect(
          await formattingTransformationRanges(source, formatted),
          JSON.stringify({ source, formatted }),
        ).toEqual(originalRanges(source, formatted));
      }
    }
  });

  it.each([
    ["", "a"],
    ["a", ""],
    ["a", "a\n"],
    ["a\n", "a"],
    ["a\r\nb\r\n", "a\nb\n"],
    ["\r", "\r\n"],
    ["a\nb\n", "a\nb\nc\n"],
    ["a\nb\nc\n", "a\nc\n"],
  ])(
    "preserves newline and insertion anchors for %j -> %j",
    async (source, formatted) => {
      expect(await formattingTransformationRanges(source, formatted)).toEqual(
        originalRanges(source, formatted),
      );
    },
  );

  it("rejects an already cancelled comparison", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      formattingTransformationRanges("a", "b", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports incomplete work when its comparison budget is exhausted", async () => {
    await expect(
      formattingTransformationRanges("a", "b", { timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "FORMATTING_DIFF_TIMEOUT" });
  });

  it("can cancel and stop a costly ambiguous comparison", async () => {
    const controller = new AbortController();
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const pending = formattingTransformationRanges(
      "a\nb\n".repeat(4000),
      "a\nc\n".repeat(4000),
      { signal: controller.signal },
    );
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("returns exact ranges from the worker and stops it after success", async () => {
    const source = "a\nb\n".repeat(300);
    const formatted = "a\nc\n".repeat(300);
    const expected = originalRanges(source, formatted);
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    expect(await formattingTransformationRanges(source, formatted)).toEqual(
      expected,
    );
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("stops the worker on timeout without returning partial ranges", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const pending = formattingTransformationRanges(
      "a\nb\n".repeat(4000),
      "a\nc\n".repeat(4000),
      { timeoutMs: 1000 },
    );
    const result = expect(pending).rejects.toMatchObject({
      code: "FORMATTING_DIFF_TIMEOUT",
    });
    vi.advanceTimersByTime(1000);
    await result;
    expect(terminate).toHaveBeenCalledOnce();
  });
});
