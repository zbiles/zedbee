import { expect, it } from "vitest";
import { currentTestSignal, runWithTestSignal } from "./current-test-signal.js";

it("keeps the current test signal available across asynchronous work", async () => {
  const signal = new AbortController().signal;

  await runWithTestSignal(signal, async () => {
    await Promise.resolve();
    expect(currentTestSignal()).toBe(signal);
  });
});

it("does not leak a test signal after its work completes", () => {
  const signal = new AbortController().signal;

  runWithTestSignal(signal, () => {
    expect(currentTestSignal()).toBe(signal);
  });

  expect(currentTestSignal()).not.toBe(signal);
});
