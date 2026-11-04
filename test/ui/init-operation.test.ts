import { describe, expect, it } from "vitest";
import {
  InitOperation,
  type InitOperationState,
} from "../../src/ui/init-operation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("InitOperation", () => {
  it("owns one action synchronously until its work settles", async () => {
    const states: InitOperationState[] = [];
    const accepted: number[] = [];
    const pending = deferred<number>();
    const action = new InitOperation<number>((state) => states.push(state));
    let starts = 0;
    const run = () => {
      starts++;
      return pending.promise;
    };
    action.start(run, (value) => accepted.push(value));
    action.start(run, (value) => accepted.push(value));
    expect(starts).toBe(1);
    expect(states).toEqual([{ status: "evaluating" }]);
    pending.resolve(42);
    await settle();
    expect(accepted).toEqual([42]);
    expect(states.at(-1)).toEqual({ status: "idle" });
  });

  it("reports rejection and allows a later retry", async () => {
    const states: InitOperationState[] = [];
    const accepted: string[] = [];
    const action = new InitOperation<string>((state) => states.push(state));
    action.start(
      async () => {
        throw new Error("Invalid formatter configuration");
      },
      (value) => accepted.push(value),
    );
    await settle();
    expect(states.at(-1)).toEqual({
      status: "error",
      message: "Invalid formatter configuration",
    });
    expect(accepted).toEqual([]);
    action.start(
      async () => "fixed",
      (value) => accepted.push(value),
    );
    await settle();
    expect(accepted).toEqual(["fixed"]);
    expect(states.at(-1)).toEqual({ status: "idle" });
  });

  it("aborts navigation and suppresses results while retaining ownership through cleanup", async () => {
    const states: InitOperationState[] = [];
    const accepted: string[] = [];
    const pending = deferred<string>();
    let signal: AbortSignal | undefined;
    const action = new InitOperation<string>((state) => states.push(state));
    action.start(
      async (value) => {
        signal = value;
        return pending.promise;
      },
      (value) => accepted.push(value),
    );
    action.cancel();
    expect(signal?.aborted).toBe(true);
    action.start(
      async () => "overlap",
      (value) => accepted.push(value),
    );
    pending.resolve("stale");
    await settle();
    expect(accepted).toEqual([]);
    expect(states).toEqual([{ status: "evaluating" }, { status: "idle" }]);
    action.start(
      async () => "fresh",
      (value) => accepted.push(value),
    );
    await settle();
    expect(accepted).toEqual(["fresh"]);
  });

  it.each(["resolve", "reject"] as const)(
    "suppresses late %s after unmount and never restarts disposed work",
    async (completion) => {
      const states: InitOperationState[] = [];
      const accepted: string[] = [];
      const pending = deferred<string>();
      let signal: AbortSignal | undefined;
      const action = new InitOperation<string>((state) => states.push(state));
      action.start(
        async (value) => {
          signal = value;
          return pending.promise;
        },
        (value) => accepted.push(value),
      );
      action.dispose();
      expect(signal?.aborted).toBe(true);
      if (completion === "resolve") pending.resolve("stale");
      else pending.reject(new Error("late failure"));
      await settle();
      action.start(
        async () => "disposed",
        (value) => accepted.push(value),
      );
      await settle();
      expect(accepted).toEqual([]);
      expect(states).toEqual([{ status: "evaluating" }]);
    },
  );
});
