import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";
import type { WindowsJob } from "./windows-job.js";
import { executionClassFor } from "../applicability.js";
import {
  AnalyzerJobError,
  analyzerDiagnostic,
  ANALYZER_FAILURE_CATEGORIES,
  type AnalyzerFailureCategory,
} from "../diagnostics.js";
import {
  CheckIncompleteError,
  type CheckIncompleteErrorOptions,
} from "../incomplete-error.js";
import {
  validateAnalyzerRequest,
  validateAnalyzerResult,
  type AnalyzerRequest,
  type AnalyzerResult,
} from "./protocol.js";

export interface AnalyzerJobOptions {
  readonly signal?: AbortSignal;
  /** Internal fault-injection dependency. Never populated by config or CLI. */
  readonly workerEntry?: string;
}

const overall = pLimit(2);
const classes = {
  lightweight: pLimit(2),
  "project-analysis": pLimit(1),
  network: pLimit(1),
};

export async function runAnalyzerJob<R extends AnalyzerRequest>(
  request: R,
  options: AnalyzerJobOptions = {},
): Promise<AnalyzerResult<R>> {
  let input: R;
  try {
    input = structuredClone(request);
    validateAnalyzerRequest(input);
  } catch {
    throw new TypeError("Invalid analyzer request");
  }
  return classes[executionClassFor(input.checkId)](() =>
    overall(() => executeAnalyzerJob(input, options)),
  );
}

async function executeAnalyzerJob<R extends AnalyzerRequest>(
  request: R,
  options: AnalyzerJobOptions,
): Promise<AnalyzerResult<R>> {
  const failure = (
    category: AnalyzerFailureCategory,
    exitCode?: number | null,
    signal?: string | null,
  ) =>
    new AnalyzerJobError(
      analyzerDiagnostic(
        request.checkId,
        request.operation,
        category,
        exitCode,
        signal,
      ),
    );
  if (options.signal?.aborted) throw failure("cancellation");
  const source = import.meta.url.endsWith(".ts");
  const extension = source ? "ts" : "js";
  const supervisorEntry = fileURLToPath(
    new URL(`./supervisor.${extension}`, import.meta.url),
  );
  const workerEntry =
    options.workerEntry ??
    fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));
  if (!existsSync(workerEntry)) throw failure("startup");
  const execArgv = source ? ["--import", import.meta.resolve("tsx")] : [];
  // An outer owner survives supervisor failure. If this caller itself dies,
  // Windows closes the noninheritable handle and kills the complete nested tree.
  let windowsJob: WindowsJob | undefined;
  let stopWindowsJob: ((job: WindowsJob) => Promise<void>) | undefined;
  if (process.platform === "win32") {
    try {
      const native = await import("./windows-job.js");
      windowsJob = native.createWindowsJob();
      stopWindowsJob = native.stopWindowsJob;
    } catch {
      throw failure("startup");
    }
    if (options.signal?.aborted) {
      windowsJob.close();
      throw failure("cancellation");
    }
  }
  return new Promise((resolve, reject) => {
    const supervisor = spawn(process.execPath, [...execArgv, supervisorEntry], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      serialization: "advanced",
    });
    let reply: unknown;
    let startupError = false;
    const cancel = () => {
      if (supervisor.connected) supervisor.send({ type: "cancel" }, () => {});
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    supervisor.on("error", () => {
      startupError = true;
    });
    supervisor.on("message", (message) => {
      reply = message;
    });
    supervisor.on("close", async (exitCode, signal) => {
      if (windowsJob && stopWindowsJob) {
        try {
          await stopWindowsJob(windowsJob);
        } catch {
          try {
            windowsJob.close();
          } catch {
            /* Preserve safe cleanup failure. */
          }
          options.signal?.removeEventListener("abort", cancel);
          reject(failure("cleanup"));
          return;
        }
      }
      options.signal?.removeEventListener("abort", cancel);
      if (options.signal?.aborted) {
        reject(failure("cancellation"));
        return;
      }
      if (startupError) {
        reject(failure("startup"));
        return;
      }
      if (exitCode !== 0 || signal !== null) {
        reject(failure("abnormal-exit", exitCode, signal));
        return;
      }
      try {
        const response = reply as {
          version?: unknown;
          ok?: unknown;
          result?: unknown;
          category?: unknown;
          exitCode?: number;
          signal?: string;
          incomplete?: CheckIncompleteErrorOptions;
        };
        if (
          !response ||
          response.version !== 1 ||
          typeof response.ok !== "boolean"
        )
          throw failure(
            exitCode === 0 ? "invalid-response" : "abnormal-exit",
            exitCode,
            signal,
          );
        if (response.ok)
          resolve(validateAnalyzerResult(request, response.result));
        else {
          if (
            !ANALYZER_FAILURE_CATEGORIES.includes(
              response.category as AnalyzerFailureCategory,
            )
          )
            throw failure("invalid-response");
          const diagnostic = {
            ...analyzerDiagnostic(
              request.checkId,
              request.operation,
              response.category as AnalyzerFailureCategory,
              response.exitCode,
              response.signal,
            ),
            ...(response.incomplete?.snapshot === undefined
              ? {}
              : {
                  snapshot:
                    response.incomplete.snapshot === "last-commit"
                      ? ("baseline" as const)
                      : ("target" as const),
                }),
          };
          if (response.incomplete !== undefined)
            throw new CheckIncompleteError({
              ...response.incomplete,
              diagnostic,
            });
          throw new AnalyzerJobError(diagnostic);
        }
      } catch (error) {
        reject(
          error instanceof AnalyzerJobError ||
            error instanceof CheckIncompleteError
            ? error
            : failure("invalid-response"),
        );
      }
    });
    supervisor.on("spawn", () => {
      try {
        if (supervisor.pid === undefined)
          throw new Error("Missing supervisor PID");
        windowsJob?.assign(supervisor.pid);
        // The engine-free supervisor cannot create workers before assignment.
        supervisor.send(
          { type: "start", workerEntry, execArgv, request },
          (error) => {
            if (error) startupError = true;
          },
        );
      } catch {
        startupError = true;
        supervisor.kill("SIGKILL");
      }
    });
    if (options.signal?.aborted) cancel();
  });
}
