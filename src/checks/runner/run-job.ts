import type { AnalyzerRequest, AnalyzerResult } from "./protocol.js";
import { createLocalAnalyzerExecutor } from "./executor.js";
import { activeAnalyzerExecutionSession } from "./session.js";

export interface AnalyzerJobOptions {
  readonly signal?: AbortSignal;
  /** Internal test entry injection; never populated by config, CLI or service. */
  readonly workerEntry?: string;
}
const localExecutor = createLocalAnalyzerExecutor();
export async function runAnalyzerJob<R extends AnalyzerRequest>(
  request: R,
  options: AnalyzerJobOptions = {},
): Promise<AnalyzerResult<R>> {
  const active = activeAnalyzerExecutionSession();
  if (active) return active.run(request, options);
  const session = await localExecutor.openSession();
  try {
    return await session.run(request, options);
  } finally {
    await session.close();
  }
}
