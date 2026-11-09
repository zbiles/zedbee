import {
  performanceObserver,
  recordExecutionMode,
} from "../../diagnostics/scan-performance.js";
import type { AnalyzerRequest, AnalyzerResult } from "./protocol.js";
import { createLocalAnalyzerExecutor } from "./executor.js";
import { activeAnalyzerExecutionSession } from "./session.js";

export interface AnalyzerJobOptions {
  readonly signal?: AbortSignal;
  /** Internal test entry injection; never populated by config, CLI or service. */
  readonly workerEntry?: string;
  readonly onTiming?: (kind: "queue" | "worker", durationMs: number) => void;
}
const localExecutor = createLocalAnalyzerExecutor();
export async function runAnalyzerJob<R extends AnalyzerRequest>(
  request: R,
  options: AnalyzerJobOptions = {},
): Promise<AnalyzerResult<R>> {
  const observer = performanceObserver(request.checkId);
  if (observer && !options.onTiming)
    options = { ...options, onTiming: observer };
  const active = activeAnalyzerExecutionSession();
  if (active) {
    recordExecutionMode(active.executionMode ?? "local", active.workerCount);
    return active.run(request, options);
  }
  const session = await localExecutor.openSession();
  try {
    recordExecutionMode("local", session.workerCount);
    return await session.run(request, options);
  } finally {
    await session.close();
  }
}
