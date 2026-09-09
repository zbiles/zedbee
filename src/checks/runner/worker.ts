import { restoreCheckContext, markAnalyzerWorker } from "./context.js";
import { validateAnalyzerRequest, type AnalyzerRequest } from "./protocol.js";
import { loadAnalyzerAdapter } from "./registry.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import { AnalyzerJobError, type AnalyzerDiagnostic } from "../diagnostics.js";
import { sendWorkerReply } from "./send-worker-reply.js";
import { exactFields } from "./envelope.js";
import {
  createAnalysisReuseSession,
  withAnalysisReuseSession,
  type AnalysisReuseSession,
} from "../analysis-reuse.js";
import {
  importAnalysisSourceCapture,
  withAnalysisSourceCapture,
  type AnalysisSourceCapture,
} from "../../inspection/source-capture.js";
import { withAnalyzerRetentionState } from "./session.js";
import type { Serializable } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

markAnalyzerWorker();
let controller: AbortController | undefined;
let sessionId: string | undefined;
let reuse: AnalysisReuseSession | undefined;
let capture: AnalysisSourceCapture | undefined;
let busy = false;
let retention = { retire: false };
const loaded = new Set<string>();
process.on("disconnect", () => controller?.abort());
process.on("message", (message: unknown) => {
  void receive(message).catch(() => process.exit(1));
});

async function receive(message: unknown): Promise<void> {
  if (exactFields(message, ["type"]) && message.type === "cancel") {
    controller?.abort();
    return;
  }
  if (
    exactFields(message, ["version", "type", "sessionId"]) &&
    message.version === 1 &&
    message.type === "release"
  ) {
    if (busy || message.sessionId !== sessionId)
      throw new Error("Invalid release");
    busy = true;
    const released = sessionId;
    await reuse?.close();
    await capture?.close();
    reuse = undefined;
    capture = undefined;
    sessionId = undefined;
    controller = undefined;
    if (loaded.has("syntax"))
      (await import("@typescript-eslint/parser")).clearCaches();
    if (loaded.has("formatting"))
      await (await import("prettier")).clearConfigCache();
    const retire = retention.retire;
    retention = { retire: false };
    busy = false;
    await sendWorkerReply({
      version: 1,
      type: "released",
      sessionId: released,
      retire,
    });
    return;
  }
  if (
    !exactFields(message, [
      "version",
      "type",
      "sessionId",
      "jobId",
      "request",
      "capture",
    ]) ||
    message.version !== 1 ||
    message.type !== "job" ||
    typeof message.sessionId !== "string" ||
    typeof message.jobId !== "string" ||
    busy
  )
    throw new Error("Invalid job envelope");
  if (
    sessionId !== undefined &&
    (message.sessionId !== sessionId || message.capture !== undefined)
  )
    throw new Error("Invalid session binding");
  busy = true;
  if (sessionId === undefined) {
    sessionId = message.sessionId;
    reuse = createAnalysisReuseSession();
    if (message.capture !== undefined)
      capture = importAnalysisSourceCapture(message.capture);
  }
  const identity = await executeAndReply(message);
  message = undefined;
  // The completed helper retains no request/result locals. Readiness contains
  // only IDs, so release may safely clear the session after this acknowledgement.
  await new Promise<void>((resolve) => setImmediate(resolve));
  busy = false;
  await sendWorkerReply({ ...identity, type: "ready" });
}
async function executeAndReply(message: Record<string, unknown>) {
  const identity = { version: 1, sessionId, jobId: message.jobId as string };
  controller = new AbortController();
  const request = message.request as AnalyzerRequest;
  if (
    [
      "lint",
      "reactCorrectness",
      "reactAccessibility",
      "cyclomaticComplexity",
      "readabilityComplexity",
    ].includes(request?.checkId)
  )
    loaded.add("syntax");
  if (request?.checkId === "formatting") loaded.add("formatting");
  const run = () =>
    withAnalysisReuseSession(reuse!, () =>
      withAnalyzerRetentionState(retention, () =>
        execute(request, controller!),
      ),
    );
  const response = capture
    ? await withAnalysisSourceCapture(capture, run)
    : await run();
  await sendWorkerReply({
    ...identity,
    type: "result",
    response,
  } as Serializable);
  return identity;
}
async function execute(request: AnalyzerRequest, controller: AbortController) {
  let phase: "startup" | "execution" = "startup";
  try {
    validateAnalyzerRequest(request);
    let result: unknown;
    if (request.operation === "format-working-source") {
      const { format } = await import("prettier");
      const { prettierParserFor } =
        await import("../prettier/supported-path.js");
      const { prettierOptions } = await import("../prettier/settings.js");
      phase = "execution";
      controller.signal.throwIfAborted();
      const parser = prettierParserFor(request.input.file);
      if (parser === undefined)
        throw new TypeError("Unsupported formatting input");
      result = await format(request.input.source, {
        ...prettierOptions(request.input.settings),
        filepath: request.input.file,
        parser,
      });
    } else {
      if (request.checkId === "secrets" && !loaded.has("secrets")) {
        // The public profiler is an owned Secretlint dependency, not a direct
        // Zedbee dependency. Its unused default observer retains file paths.
        // Disable it before any source analysis, only inside this worker.
        const require = createRequire(import.meta.resolve("@secretlint/core"));
        const { secretLintProfiler } = (await import(
          pathToFileURL(require.resolve("@secretlint/profiler")).href
        )) as {
          secretLintProfiler: { setEnabled(enabled: boolean): void };
        };
        secretLintProfiler.setEnabled(false);
        loaded.add("secrets");
      }
      const adapter = await loadAnalyzerAdapter(request.checkId);
      const context = restoreCheckContext(request.context, controller.signal);
      phase = "execution";
      controller.signal.throwIfAborted();
      if (request.operation === "planFixes") {
        if (!adapter.planFixes)
          throw new TypeError("Unsupported fix operation");
        result = await adapter.planFixes(context, request.findings);
      } else if (
        request.operation === "collect" &&
        adapter.output === "observations"
      )
        result = await adapter.collect(context);
      else if (
        request.operation === "runLegacy" &&
        adapter.output === "legacy-check-result"
      )
        result = await adapter.runLegacy(context);
      else throw new TypeError("Unsupported analyzer operation");
    }
    controller.signal.throwIfAborted();
    return { version: 1, ok: true, result };
  } catch (error) {
    let diagnostic: AnalyzerDiagnostic | undefined;
    let cause = error;
    for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
      if (cause instanceof AnalyzerJobError) {
        diagnostic = cause.diagnostic;
        break;
      }
      cause = cause.cause;
    }
    // Only the existing deliberate display-safe incomplete contract crosses IPC.
    // Exception stacks, causes and dependency stderr are never copied.
    const incomplete =
      error instanceof CheckIncompleteError
        ? {
            code: error.code,
            message: error.message,
            remediation: error.remediation,
            ...(error.path === undefined ? {} : { path: error.path }),
            ...(error.paths === undefined ? {} : { paths: error.paths }),
            ...(error.snapshot === undefined
              ? {}
              : { snapshot: error.snapshot }),
            ...(error.projectPaths === undefined
              ? {}
              : { projectPaths: error.projectPaths }),
            ...(error.disposition === undefined
              ? {}
              : { disposition: error.disposition }),
          }
        : undefined;
    return {
      version: 1,
      ok: false,
      category: controller.signal.aborted
        ? "cancellation"
        : (diagnostic?.category ?? phase),
      ...(diagnostic?.exitCode === undefined
        ? {}
        : { exitCode: diagnostic.exitCode }),
      ...(diagnostic?.signal === undefined
        ? {}
        : { signal: diagnostic.signal }),
      ...(incomplete === undefined ? {} : { incomplete }),
    };
  }
}
