export async function settleSnapshotSides<T>(
  baseline: Promise<T>,
  target: Promise<T>,
  signal: AbortSignal,
): Promise<readonly [T, T]> {
  const [baselineResult, targetResult] = await Promise.allSettled([
    baseline,
    target,
  ]);
  signal.throwIfAborted();
  if (baselineResult.status === "rejected") throw baselineResult.reason;
  if (targetResult.status === "rejected") throw targetResult.reason;
  return [baselineResult.value, targetResult.value];
}
