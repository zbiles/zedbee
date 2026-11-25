import { expect, test } from "vitest";
import { benchmarkSamples } from "../../bench/sample-modes.mjs";

test.each(["cold", "warm-engine", "warm-cache"] as const)(
  "%s has explicit cache and executor lifetimes",
  async (mode) => {
    let opened = 0,
      closed = 0;
    const calls: { executor: number; cache: boolean }[] = [];
    const results = await benchmarkSamples({
      mode,
      samples: 3,
      open: async () => ++opened,
      close: async () => {
        closed++;
      },
      run: async (executor: number, cache: boolean) => {
        calls.push({ executor, cache });
        return calls.length;
      },
    });
    expect(results).toHaveLength(3);
    expect(opened).toBe(mode === "cold" ? 3 : 1);
    expect(closed).toBe(opened);
    expect(calls.every((c) => c.cache === (mode === "warm-cache"))).toBe(true);
    expect(calls).toHaveLength(mode === "cold" ? 3 : 4);
  },
);
test("closes the executor when a sample fails", async () => {
  let closed = 0;
  await expect(
    benchmarkSamples({
      mode: "cold",
      samples: 2,
      open: async () => 1,
      close: async () => {
        closed++;
      },
      run: async () => {
        throw Error("sample");
      },
    }),
  ).rejects.toThrow("sample");
  expect(closed).toBe(1);
});
