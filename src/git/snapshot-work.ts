type Side = "baseline" | "target";
export interface SnapshotWorkOwner {
  readonly signal: AbortSignal;
  readonly failure:
    { readonly side: Side; readonly error: unknown } | undefined;
  fail(side: Side, error: unknown): void;
  dispose(): void;
}

export function createSnapshotWorkOwner(
  signal?: AbortSignal,
): SnapshotWorkOwner {
  const controller = new AbortController();
  let failure: SnapshotWorkOwner["failure"];
  const abort = () => controller.abort(signal!.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    get failure() {
      return failure;
    },
    fail(side, error) {
      if (controller.signal.aborted) return;
      // Record before abort listeners can produce secondary GIT_ABORTED errors.
      failure = { side, error };
      controller.abort(error);
    },
    dispose() {
      signal?.removeEventListener("abort", abort);
    },
  };
}

export async function settleSnapshotWork<T, U>(
  baseline: (signal: AbortSignal) => Promise<T>,
  target: (signal: AbortSignal) => Promise<U>,
  options: {
    signal?: AbortSignal;
    owner?: SnapshotWorkOwner;
    onFailure?: (side: Side) => void;
  } = {},
): Promise<readonly [T, U]> {
  const owner = options.owner ?? createSnapshotWorkOwner(options.signal);
  const run = async <V>(
    side: Side,
    operation: (signal: AbortSignal) => Promise<V>,
  ) => {
    try {
      owner.signal.throwIfAborted();
      return await operation(owner.signal);
    } catch (error) {
      owner.fail(side, error);
      throw error;
    }
  };
  try {
    const results = await Promise.allSettled([
      run("baseline", baseline),
      run("target", target),
    ]);
    if (owner.failure) {
      options.onFailure?.(owner.failure.side);
      throw owner.failure.error;
    }
    if (results[0].status === "rejected") throw results[0].reason;
    if (results[1].status === "rejected") throw results[1].reason;
    owner.signal.throwIfAborted();
    return [results[0].value, results[1].value];
  } finally {
    if (!options.owner) owner.dispose();
  }
}
