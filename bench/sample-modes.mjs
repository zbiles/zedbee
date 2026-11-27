/** Engine/service cold does not mean OS filesystem caches are flushed. */
export async function benchmarkSamples({ mode, samples, open, close, run }) {
  if (
    !["cold", "warm-engine", "warm-cache"].includes(mode) ||
    !Number.isInteger(samples) ||
    samples < 1
  )
    throw new TypeError("Invalid benchmark mode or sample count");
  const results = [];
  if (mode === "cold") {
    for (let i = 0; i < samples; i++) {
      const executor = await open();
      try {
        results.push(await run(executor, false));
      } finally {
        await close(executor);
      }
    }
  } else {
    const executor = await open();
    try {
      await run(executor, mode === "warm-cache");
      for (let i = 0; i < samples; i++)
        results.push(await run(executor, mode === "warm-cache"));
    } finally {
      await close(executor);
    }
  }
  return results;
}

export function median(values) {
  if (!values.length) throw new Error("Cannot summarize an empty sample.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function matchesCacheMode(mode, { gets, hits, sets }) {
  if (
    ![gets, hits, sets].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) ||
    hits > gets
  )
    return false;
  if (mode === "off") return gets === 0 && sets === 0;
  if (mode === "cold") return gets > 0 && hits === 0;
  return mode === "warm" && hits > 0;
}
