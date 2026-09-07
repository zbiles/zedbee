import { restoreCheckContext, markAnalyzerWorker } from "./context.js";
import { validateAnalyzerRequest, type AnalyzerRequest } from "./protocol.js";
import { loadAnalyzerAdapter } from "./registry.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import { AnalyzerJobError, type AnalyzerDiagnostic } from "../diagnostics.js";
import { sendWorkerReply } from "./send-worker-reply.js";

markAnalyzerWorker();
const controller = new AbortController();
let started = false;
process.on("disconnect", () => controller.abort());
process.on("message", async (message: unknown) => {
  if ((message as { type?: unknown })?.type === "cancel") {
    controller.abort();
    return;
  }
  if (started) return;
  started = true;
  let phase: "startup" | "execution" = "startup";
  try {
    const request = message as AnalyzerRequest;
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
    sendWorkerReply({ version: 1, ok: true, result });
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
    sendWorkerReply({
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
    });
  }
});
