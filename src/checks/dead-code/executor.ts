import { Worker } from "node:worker_threads";
import type { DependencyCaptureContext } from "../../cache/captured-dependencies.js";
import {
  sanitizeDependencyInputManifest,
  type DependencyInputManifest,
} from "../../cache/dependency-inputs.js";
import type { AnalysisSourceCaptureTransport } from "../../inspection/source-capture.js";
import type { ManagedKnipConfig } from "./managed-config.js";

export interface KnipJob {
  readonly context: DependencyCaptureContext;
  readonly snapshotRoot: string;
  readonly config: ManagedKnipConfig;
  readonly workspace: string;
  readonly sourceCapture?: AnalysisSourceCaptureTransport;
}

export function sanitizeKnipReply(value: unknown): {
  report: unknown;
  dependencyInputs?: DependencyInputManifest;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "result" ||
    !("report" in value) ||
    Object.keys(value).some(
      (key) => !["type", "report", "dependencyInputs"].includes(key),
    )
  )
    throw new TypeError("Invalid Knip worker reply");
  if (
    typeof value.report !== "object" ||
    value.report === null ||
    !("issues" in value.report) ||
    !Array.isArray(value.report.issues) ||
    Buffer.byteLength(JSON.stringify(value.report)) > 64 * 1024 * 1024
  )
    throw new TypeError("Invalid Knip report");
  const metadata =
    "dependencyInputs" in value ? value.dependencyInputs : undefined;
  return {
    report: value.report,
    ...(metadata === undefined
      ? {}
      : { dependencyInputs: sanitizeDependencyInputManifest(metadata) }),
  };
}

/** Fixed internal entry; each side owns its opaque Knip globals until final exit. */
export async function runCapturedKnip(
  job: KnipJob,
  signal: AbortSignal,
): Promise<{ report: unknown; dependencyInputs?: DependencyInputManifest }> {
  signal.throwIfAborted();
  const entry = new URL(
    import.meta.url.endsWith(".ts")
      ? "../../../dist/checks/dead-code/knip-worker.js"
      : "./knip-worker.js",
    import.meta.url,
  );
  const worker = new Worker(entry, {
    workerData: job,
    execArgv: [],
    stdout: true,
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 384 },
  });
  worker.stdout.resume();
  worker.stderr.resume();
  let result:
    { report: unknown; dependencyInputs?: DependencyInputManifest } | undefined;
  let failed = false;
  const stop = () => {
    failed = true;
    void worker.terminate();
  };
  const exited = new Promise<void>((resolve, reject) => {
    worker.once("error", stop);
    worker.on("message", (value: unknown) => {
      try {
        if (result !== undefined) throw new TypeError("Duplicate Knip reply");
        result = sanitizeKnipReply(value);
      } catch {
        stop();
      }
    });
    worker.once("exit", (code) => {
      if (code !== 0 || failed || result === undefined)
        reject(new Error("Captured Knip worker failed"));
      else resolve();
    });
  });
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    await exited;
    signal.throwIfAborted();
    return result!;
  } finally {
    signal.removeEventListener("abort", stop);
    await worker.terminate();
  }
}
