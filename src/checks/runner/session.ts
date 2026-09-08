import { AsyncLocalStorage } from "node:async_hooks";
import type { AnalyzerExecutionSession } from "./executor.js";

const active = new AsyncLocalStorage<AnalyzerExecutionSession>();
const retained = new AsyncLocalStorage<{ retire: boolean }>();
export function markUnresettableAnalyzerState(): void {
  const state = retained.getStore();
  if (state) state.retire = true;
}
export function withAnalyzerRetentionState<T>(
  state: { retire: boolean },
  run: () => Promise<T>,
): Promise<T> {
  return retained.run(state, run);
}
export function activeAnalyzerExecutionSession():
  AnalyzerExecutionSession | undefined {
  return active.getStore();
}
export async function withAnalyzerExecutionSession<T>(
  session: AnalyzerExecutionSession,
  run: () => Promise<T>,
): Promise<T> {
  return active.run(session, run);
}
