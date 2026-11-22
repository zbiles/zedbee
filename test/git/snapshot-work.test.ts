import { joinSnapshotReaders } from "../../src/git/snapshot-work.js";
import { describe, expect, it } from "vitest";
import { settleSnapshotWork } from "../../src/git/snapshot-work.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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
});

it("does not release a snapshot when a sibling reader is still active", async () => {
  const failure = new Error("first reader rejected");
  let finishReader!: (value: string) => void;
  const reader = new Promise<string>((resolve) => {
    finishReader = resolve;
  });
  let settled = false;
  const result = joinSnapshotReaders([Promise.reject(failure), reader]).finally(
    () => {
      settled = true;
    },
  );
  const expectation = expect(result).rejects.toBe(failure);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  finishReader("last reader completed");
  await expectation;
  expect(settled).toBe(true);
});
