import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  worker: undefined as import("node:worker_threads").Worker | undefined,
  events: [] as string[],
  gate: Promise.resolve(),
  terminationRequested: () => {},
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class ControlledWorker extends actual.Worker {
      constructor() {
        // Only this test substitutes the fixed engine worker with trusted code.
        // A real native Worker/MessagePort exercises the owner's actual listeners.
        super(
          `const { parentPort } = require("node:worker_threads");
           parentPort.on("message", command => {
             if (command === "malformed") parentPort.postMessage({ type: "result", report: null });
             if (command === "duplicate") {
               parentPort.postMessage({ type: "result", report: { issues: [] } });
               parentPort.postMessage({ type: "result", report: { issues: [] } });
             }
             if (command === "no-result") parentPort.close();
           });`,
          { eval: true, execArgv: [], stdout: true, stderr: true },
        );
        control.worker = this;
        this.once("exit", () => control.events.push("exit"));
      }

      override terminate(): Promise<number> {
        control.terminationRequested();
        // Hold actual exit after the owner has detected a protocol failure.
        // Early rejection would therefore be observable, not a timing guess.
        return control.gate.then(() => super.terminate());
      }
    },
  };
});

import {
  runCapturedKnip,
  type KnipJob,
} from "../../../src/checks/dead-code/executor.js";

describe("fixed Knip worker failure ownership", () => {
  it.each(["malformed", "duplicate", "no-result"] as const)(
    "awaits exit and releases the native port after %s output",
    async (command) => {
      const ports = () =>
        process
          .getActiveResourcesInfo()
          .filter((name) => name === "MessagePort").length;
      const before = ports();
      let release = () => {};
      control.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        control.terminationRequested = resolve;
      });
      control.events = [];
      control.worker = undefined;
      let settled = false;
      // The mocked constructor never consumes this job or loads engine code.
      const outcome = runCapturedKnip(
        {} as KnipJob,
        new AbortController().signal,
      ).then(
        () => {
          settled = true;
          control.events.push("resolved");
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          control.events.push("rejected");
          return error;
        },
      );
      const worker = control.worker!;
      try {
        expect(worker).toBeDefined();
        await nextTurn();
        expect(settled).toBe(false);
        worker.postMessage(command);
        if (command !== "no-result") {
          await Promise.race([
            requested,
            outcome.then(() => {
              throw new Error("Settled before requesting worker termination");
            }),
          ]);
          await nextTurn();
          expect(settled).toBe(false);
          expect(control.events).not.toContain("exit");
          expect(worker.threadId).not.toBe(-1);
        }
        release();
        expect(await outcome).toEqual(new Error("Captured Knip worker failed"));
        expect(control.events).toEqual(["exit", "rejected"]);
        expect(worker.threadId).toBe(-1);
        await nextTurn();
        expect(ports()).toBe(before);
      } finally {
        release();
        await worker?.terminate();
        await outcome;
      }
    },
  );
});
