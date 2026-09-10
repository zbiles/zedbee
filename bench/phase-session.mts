import type { AnalyzerExecutor } from "../dist/checks/runner/executor.js";
import { withAnalyzerExecutionSession } from "../dist/checks/runner/session.js";

/** Phase samples share a session, just as analyzer jobs within one scan do. */
export async function withPhaseSession<T>(
  executor: AnalyzerExecutor,
  run: () => Promise<T>,
): Promise<T> {
  const session = await executor.openSession();
  try {
    return await withAnalyzerExecutionSession(session, run);
  } finally {
    await session.close();
  }
}
