import { expect, it } from "vitest";
import { withPhaseSession } from "../../bench/phase-session.mjs";
import {
  createLocalAnalyzerExecutor,
  type AnalyzerExecutionSession,
} from "../../dist/checks/runner/executor.js";
import { activeAnalyzerExecutionSession } from "../../dist/checks/runner/session.js";
import { runAnalyzerJob } from "../../dist/checks/runner/run-job.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../dist/checks/prettier/settings.js";

it.each([false, true])(
  "shares the phase session and closes it after callback failure: %s",
  async (fail) => {
    const executor = createLocalAnalyzerExecutor();
    const failure = new Error("phase failed");
    const request = {
      version: 1,
      checkId: "formatting",
      operation: "format-working-source",
      input: {
        file: "value.js",
        source: "const value=1",
        settings: DEFAULT_FORMATTING_SETTINGS,
      },
    } as const;
    let session: AnalyzerExecutionSession | undefined;
    try {
      const pending = withPhaseSession(executor, async () => {
        session = activeAnalyzerExecutionSession();
        expect(session).toBeDefined();
        expect(await runAnalyzerJob(request)).toBe("const value = 1;\n");
        expect(
          await runAnalyzerJob({
            ...request,
            input: { ...request.input, source: "const value=2" },
          }),
        ).toBe("const value = 2;\n");
        if (fail) throw failure;
        return "complete";
      });
      if (fail) await expect(pending).rejects.toBe(failure);
      else await expect(pending).resolves.toBe("complete");
      expect(activeAnalyzerExecutionSession()).toBeUndefined();
      await expect(session!.run(request)).rejects.toThrow();
    } finally {
      await executor.close();
    }
  },
);
