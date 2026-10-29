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
