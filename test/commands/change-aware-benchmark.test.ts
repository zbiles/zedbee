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

test("uses the arithmetic middle for every sample size and distinguishes disabled cache from forced misses", async () => {
  const { median, matchesCacheMode } =
    await import("../../bench/sample-modes.mjs");
  expect(median([9, 1])).toBe(5);
  expect(median([1, 9, 2])).toBe(2);
  expect(median([3, 3])).toBe(3);
  expect(matchesCacheMode("off", { gets: 0, hits: 0, sets: 0 })).toBe(true);
  expect(matchesCacheMode("off", { gets: 2, hits: 0, sets: 0 })).toBe(false);
  expect(matchesCacheMode("cold", { gets: 2, hits: 0, sets: 1 })).toBe(true);
  expect(matchesCacheMode("warm", { gets: 2, hits: 1, sets: 0 })).toBe(true);
});
