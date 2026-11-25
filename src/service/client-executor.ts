import { recordPerformance } from "../diagnostics/scan-performance.js";
import {
  analyzerRequestRetentionBytes,
  exactFields,
} from "../checks/runner/envelope.js";
import {
  validateAnalyzerRequest,
  validateAnalyzerResult,
  type AnalyzerRequest,
  type AnalyzerResult,
} from "../checks/runner/protocol.js";
import type {
  AnalyzerExecutor,
  AnalyzerExecutionSession,
  AnalyzerExecutionSessionOptions,
} from "../checks/runner/executor.js";
import type { AnalyzerJobOptions } from "../checks/runner/run-job.js";
import { HEX, ServiceUnavailableError } from "./protocol.js";

/** Closing must settle independent tree/lease witnesses before resolving. */
export interface ServiceSessionConnection {
  request(
    op: string,
    fields?: Record<string, unknown>,
    signal?: AbortSignal,
    request?: AnalyzerRequest,
  ): Promise<unknown>;
  closeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export function executorForConnection(
  client: ServiceSessionConnection,
): AnalyzerExecutor {
  const sessions = new Set<AnalyzerExecutionSession>();
  let closed = false,
    closing: Promise<void> | undefined;
  return {
    async openSession(options: AnalyzerExecutionSessionOptions = {}) {
      if (closed) throw new ServiceUnavailableError();
      analyzerRequestRetentionBytes(options);
      if (!exactFields(options, ["sourceSelections"]))
        throw new ServiceUnavailableError();
      const result = await client.request("open", { options });
      if (
        !exactFields(result, ["sessionId"]) ||
        typeof result.sessionId !== "string" ||
        !HEX.test(result.sessionId)
      )
        throw new ServiceUnavailableError();
      const sessionId = result.sessionId;
      let released = false,
        release: Promise<void> | undefined;
      const session: AnalyzerExecutionSession = {
        executionMode: "service",
        async run<R extends AnalyzerRequest>(
          request: R,
          options: AnalyzerJobOptions = {},
        ): Promise<AnalyzerResult<R>> {
          if (released || closed) throw new ServiceUnavailableError();
          const signal = options.signal;
          const onTiming = options.onTiming;
          if (!exactFields(options, ["signal", "onTiming"]))
            throw new ServiceUnavailableError();
          analyzerRequestRetentionBytes(request);
          const captured = structuredClone(request);
          validateAnalyzerRequest(captured);
          const measured = onTiming !== undefined;
          const serviceStarted = performance.now();
          const response = await client.request(
            measured ? "run-measured" : "run",
            { sessionId, request: captured },
            signal,
            captured,
          );
          recordPerformance({
            checkId: request.checkId,
            kind: "service",
            durationMs: performance.now() - serviceStarted,
          });
          if (!measured) return validateAnalyzerResult(captured, response);
          if (
            !exactFields(response, ["result", "timings"]) ||
            !Array.isArray(response.timings) ||
            response.timings.length > 3
          )
            throw new ServiceUnavailableError();
          for (const timing of response.timings) {
            if (
              !exactFields(timing, ["kind", "durationMs"]) ||
              !["queue", "worker", "result"].includes(timing.kind as string) ||
              typeof timing.durationMs !== "number" ||
              !Number.isSafeInteger(timing.durationMs) ||
              timing.durationMs < 0 ||
              timing.durationMs > 604800000
            )
              throw new ServiceUnavailableError();
          }
          const result = validateAnalyzerResult(captured, response.result);
          for (const timing of response.timings) {
            try {
              onTiming?.(timing.kind, timing.durationMs);
            } catch {}
          }
          return result;
        },
        close() {
          if (!release) {
            released = true;
            release = client.closeSession(sessionId).then(() => {
              sessions.delete(session);
            });
          }
          return release;
        },
      };
      sessions.add(session);
      if (closed) {
        await session.close();
        throw new ServiceUnavailableError();
      }
      return session;
    },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          try {
            const results = await Promise.allSettled(
              [...sessions].map((session) => session.close()),
            );
            const failure = results.find(
              (result) => result.status === "rejected",
            );
            if (failure?.status === "rejected") throw failure.reason;
          } finally {
            await client.close();
          }
        })();
      }
      return closing;
    },
  };
}
