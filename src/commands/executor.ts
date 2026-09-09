import {
  createLocalAnalyzerExecutor,
  type AnalyzerExecutor,
} from "../checks/runner/executor.js";
import { acquireServiceExecutor } from "../service/client.js";
import { AnalysisSessionCleanupError } from "../scan/analysis-failure.js";

/** Command-owned lazy connection: help/empty-index paths never start a service. */
export function createCommandExecutor(service = true): AnalyzerExecutor {
  let executor: Promise<AnalyzerExecutor> | undefined;
  let closing: Promise<void> | undefined;
  const prepare = () => {
    if (closing) throw new Error("Analyzer executor is closed.");
    executor ??= service
      ? acquireServiceExecutor()
      : Promise.resolve(createLocalAnalyzerExecutor());
    // Acquisition may finish before snapshot preparation reaches openSession.
    // Observe failure now while preserving the same rejection for that caller.
    void executor.catch(() => {});
  };
  return {
    prepare,
    async openSession(options) {
      prepare();
      return (await executor!).openSession(options);
    },
    close() {
      closing ??= (async () => {
        if (!executor) return;
        // Failed acquisition has no returned owner; its original error is
        // reported by the scan. A returned owner's close must never be hidden.
        const acquired = await executor.catch(() => undefined);
        try {
          await acquired?.close();
        } catch {
          throw new AnalysisSessionCleanupError();
        }
      })();
      return closing;
    },
  };
}
