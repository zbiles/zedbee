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
