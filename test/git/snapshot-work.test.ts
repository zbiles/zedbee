import { describe, expect, it } from "vitest";
import {
  createSnapshotWorkOwner,
  createSnapshotWritePool,
  settleSnapshotWork,
} from "../../src/git/snapshot-work.js";
import type { GitBlobStream } from "../../src/git/batch-object-stream.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const blob = (bytes: Buffer): GitBlobStream => ({
  objectId: "a".repeat(40),
  size: bytes.length,
  chunks: (async function* () {
    yield bytes;
  })(),
});

describe("snapshot construction work", () => {
  it("starts both sides and preserves a real failure while waiting for its aborted peer to close", async () => {
    const started = deferred();
    const close = deferred();
    const aborted = deferred();
    const original = new Error("write failed");
    let returned = false;
    const result = settleSnapshotWork(
      async (signal) => {
        started.resolve();
        signal.addEventListener("abort", () => aborted.resolve(), {
          once: true,
        });
        await close.promise;
        throw signal.reason;
      },
      async () => {
        await started.promise;
        throw original;
      },
    );
    const observed = result.catch((error) => {
      returned = true;
      return error;
    });
    await aborted.promise;
    expect(returned).toBe(false);
    close.resolve();
    expect(await observed).toBe(original);
  });

  it.each(["baseline", "target"] as const)(
    "propagates a detached %s write failure to both held readers before settle",
    async (side) => {
      const owner = createSnapshotWorkOwner();
      const pool = createSnapshotWritePool(owner);
      const fail = deferred();
      const readersAborted = [deferred(), deferred()];
      const close = deferred();
      const original = new Error("detached write error");
      const readers = settleSnapshotWork(
        async (signal) => {
          signal.addEventListener("abort", () => readersAborted[0]!.resolve(), {
            once: true,
          });
          await close.promise;
        },
        async (signal) => {
          signal.addEventListener("abort", () => readersAborted[1]!.resolve(), {
            once: true,
          });
          await close.promise;
        },
        { owner },
      );
      const observed = readers.catch((error) => error);
      await pool.enqueue(side, blob(Buffer.from("content")), async () => {
        await fail.promise;
        throw original;
      });
      fail.resolve();
      await Promise.all(readersAborted.map((reader) => reader.promise));
      expect(owner.signal.aborted).toBe(true);
      await expect(
        pool.enqueue(side, blob(Buffer.from("late")), async () => {}),
      ).rejects.toThrow();
      close.resolve();
      expect(await observed).toBe(original);
      await expect(pool.settle()).rejects.toBe(original);
      expect(pool.stats()).toMatchObject({
        activeWrites: 0,
        admittedJobs: 0,
        bufferedBytes: 0,
      });
      owner.dispose();
    },
  );

  it("bounds work across sides, owns copied bytes and releases every reservation", async () => {
    const owner = createSnapshotWorkOwner();
    const pool = createSnapshotWritePool(owner);
    const release = deferred();
    const active = deferred();
    const upstream = Buffer.alloc(128 * 1024, 65);
    const written: number[] = [];
    const jobs = Array.from({ length: 12 }, (_, i) =>
      pool.enqueue(
        i % 2 ? "baseline" : "target",
        blob(upstream),
        async (owned) => {
          if (pool.stats().activeWrites === 4) active.resolve();
          await release.promise;
          for await (const chunk of owned.chunks) written.push(chunk[0]!);
        },
      ),
    );
    await active.promise;
    // All first active jobs consumed/copied their input before admission returned.
    await Promise.all(jobs.slice(0, 4));
    expect(pool.stats().peakActiveWrites).toBe(4);
    expect(pool.stats().peakAdmittedJobs).toBeLessThanOrEqual(8);
    expect(pool.stats().peakBufferedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    upstream.fill(66);
    release.resolve();
    await Promise.all(jobs);
    await pool.settle();
    expect(written.slice(0, 4)).toEqual([65, 65, 65, 65]);
    expect(pool.stats()).toMatchObject({
      activeWrites: 0,
      admittedJobs: 0,
      bufferedBytes: 0,
    });
    owner.dispose();
  });

  it("shares active slots with streaming jobs and wakes admission on caller cancellation", async () => {
    const controller = new AbortController();
    const owner = createSnapshotWorkOwner(controller.signal);
    const pool = createSnapshotWritePool(owner);
    const started = deferred();
    const release = deferred();
    const jobs = Array.from({ length: 4 }, () =>
      pool.stream("baseline", async () => {
        if (pool.stats().activeWrites === 4) started.resolve();
        await release.promise;
      }),
    );
    await started.promise;
    const waiting = pool.enqueue(
      "target",
      blob(Buffer.from("queued")),
      async () => {},
    );
    const observed = waiting.catch((error) => error);
    controller.abort(new Error("cancelled"));
    release.resolve();
    await Promise.allSettled(jobs);
    await observed;
    await expect(pool.settle()).rejects.toThrow("cancelled");
    expect(pool.stats().peakActiveWrites).toBe(4);
    owner.dispose();
  });
});
