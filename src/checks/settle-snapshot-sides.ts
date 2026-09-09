export async function settleSnapshotSides<T>(
  baseline: () => Promise<T>,
  target: () => Promise<T>,
  signal: AbortSignal,
  sequential = true,
): Promise<readonly [T, T]> {
  signal.throwIfAborted();
  const settle = async (
    run: () => Promise<T>,
  ): Promise<PromiseSettledResult<T>> => {
    try {
      return { status: "fulfilled", value: await run() };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  };
  let results: readonly [PromiseSettledResult<T>, PromiseSettledResult<T>];
  if (sequential) {
    const before = await settle(baseline);
    signal.throwIfAborted();
    results = [before, await settle(target)];
  } else {
    // Retain the historical concurrency of direct injected adapter harnesses.
    // Every shipped analyzer job requests sequential snapshot sides.
    results = await Promise.all([settle(baseline), settle(target)]);
  }
  const [before, after] = results;
  signal.throwIfAborted();
  if (before.status === "rejected") throw before.reason;
  if (after.status === "rejected") throw after.reason;
  return [before.value, after.value];
}
