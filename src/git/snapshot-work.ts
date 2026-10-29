import type { GitBlobStream } from "./batch-object-stream.js";

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

interface PoolStats {
  activeWrites: number;
  admittedJobs: number;
  bufferedBytes: number;
  peakActiveWrites: number;
  peakAdmittedJobs: number;
  peakBufferedBytes: number;
}
interface Job {
  side: Side;
  bytes: number;
  write(): Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}
export interface SnapshotWritePool {
  enqueue(
    side: Side,
    blob: GitBlobStream,
    write: (blob: GitBlobStream, signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
  stream(
    side: Side,
    write: (signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
  cancel(reason: unknown): void;
  settle(): Promise<void>;
  stats(): Readonly<PoolStats>;
}

export function createSnapshotWritePool(
  owner: SnapshotWorkOwner,
): SnapshotWritePool {
  const stats: PoolStats = {
    activeWrites: 0,
    admittedJobs: 0,
    bufferedBytes: 0,
    peakActiveWrites: 0,
    peakAdmittedJobs: 0,
    peakBufferedBytes: 0,
  };
  const queue: Job[] = [];
  const waiters = new Set<() => void>();
  let closing = false;
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const changed = () =>
    new Promise<void>((resolve) => {
      const finish = () => {
        waiters.delete(finish);
        resolve();
      };
      waiters.add(finish);
    });
  function release(bytes: number) {
    stats.admittedJobs--;
    stats.bufferedBytes -= bytes;
    wake();
  }
  const abort = () => {
    for (const job of queue.splice(0)) {
      release(job.bytes);
      job.reject(owner.signal.reason);
    }
    wake();
  };
  owner.signal.addEventListener("abort", abort, { once: true });
  async function admit(bytes: number) {
    for (;;) {
      owner.signal.throwIfAborted();
      if (closing) throw new Error("Snapshot write pool is settled.");
      if (
        stats.admittedJobs < 8 &&
        stats.bufferedBytes + bytes <= 2 * 1024 * 1024
      ) {
        stats.admittedJobs++;
        stats.bufferedBytes += bytes;
        stats.peakAdmittedJobs = Math.max(
          stats.peakAdmittedJobs,
          stats.admittedJobs,
        );
        stats.peakBufferedBytes = Math.max(
          stats.peakBufferedBytes,
          stats.bufferedBytes,
        );
        return;
      }
      await changed();
    }
  }
  function start() {
    while (!owner.signal.aborted && stats.activeWrites < 4 && queue.length) {
      const job = queue.shift()!;
      stats.activeWrites++;
      stats.peakActiveWrites = Math.max(
        stats.peakActiveWrites,
        stats.activeWrites,
      );
      void (async () => {
        try {
          await job.write();
          job.resolve();
        } catch (error) {
          owner.fail(job.side, error);
          job.reject(error);
        } finally {
          stats.activeWrites--;
          release(job.bytes);
          start();
        }
      })();
    }
  }
  function schedule(side: Side, bytes: number, write: () => Promise<void>) {
    if (owner.signal.aborted) {
      release(bytes);
      return Promise.reject(owner.signal.reason);
    }
    const result = new Promise<void>((resolve, reject) => {
      queue.push({ side, bytes, write, resolve, reject });
    });
    // Buffered jobs outlive their visitor. Observe every rejection immediately.
    void result.catch(() => {});
    start();
    return result;
  }
  return {
    async enqueue(side, blob, write) {
      if (
        !Number.isSafeInteger(blob.size) ||
        blob.size < 0 ||
        blob.size > 128 * 1024
      )
        throw new Error("Invalid buffered snapshot blob size.");
      await admit(blob.size);
      let bytes: Buffer;
      try {
        bytes = Buffer.allocUnsafe(blob.size);
        let offset = 0;
        for await (const chunk of blob.chunks) {
          owner.signal.throwIfAborted();
          if (offset + chunk.length > bytes.length)
            throw new Error("Invalid snapshot blob size.");
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        if (offset !== bytes.length)
          throw new Error("Invalid snapshot blob size.");
        owner.signal.throwIfAborted();
      } catch (error) {
        release(blob.size);
        owner.fail(side, error);
        throw error;
      }
      const owned = {
        objectId: blob.objectId,
        size: blob.size,
        chunks: (async function* () {
          yield bytes;
        })(),
      };
      void schedule(side, blob.size, () => write(owned, owner.signal));
    },
    async stream(side, write) {
      await admit(0);
      await schedule(side, 0, () => write(owner.signal));
    },
    cancel(reason) {
      owner.fail("target", reason);
    },
    async settle() {
      closing = true;
      wake();
      while (stats.admittedJobs > 0) await changed();
      owner.signal.removeEventListener("abort", abort);
      if (owner.failure) throw owner.failure.error;
      owner.signal.throwIfAborted();
    },
    stats: () => ({ ...stats }),
  };
}
