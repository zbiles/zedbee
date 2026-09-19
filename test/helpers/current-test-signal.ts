import { AsyncLocalStorage } from "node:async_hooks";

const testSignals = new AsyncLocalStorage<AbortSignal>();

export function currentTestSignal(): AbortSignal | undefined {
  return testSignals.getStore();
}

export function runWithTestSignal<T>(signal: AbortSignal, action: () => T): T {
  return testSignals.run(signal, action);
}
