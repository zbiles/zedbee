import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ZEDBEE_VERSION } from "../core/package-version.js";
import {
  telemetryContext,
  telemetryDisabled,
  type TelemetryEnvironment,
} from "./policy.js";
import { TelemetryStore, telemetryDirectory } from "./state.js";
import {
  telemetryEventSchema,
  type TelemetryEvent,
  type TelemetryCommand,
} from "./schema.js";
import { sendTelemetry, type TelemetrySend } from "./transport.js";
export const TELEMETRY_NOTICE =
  "Zedbee collects usage metadata by default (commands, timing and outcomes), including in CI. No source code, paths or report contents are sent. Disable: zedbee telemetry disable, or set ZEDBEE_TELEMETRY_DISABLED=1. Details: https://github.com/zbiles/zedbee/blob/main/docs/privacy.md#usage-telemetry\n";
export type TelemetrySummary = Partial<
  Pick<
    TelemetryEvent,
    | "empty_input"
    | "check_ids"
    | "finding_count"
    | "applied_count"
    | "skipped_count"
    | "profile"
    | "hook"
    | "outcome"
  >
>;
export interface CommandTelemetry {
  summary(value: TelemetrySummary): void;
  finish(exitCode: number): void;
  flush(cancelled: boolean, signal?: AbortSignal): Promise<void>;
}
const NOOP: CommandTelemetry = { summary() {}, finish() {}, async flush() {} };
export function launchTelemetrySender(env: TelemetryEnvironment): void {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./worker.js", import.meta.url))],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...env },
    },
  );
  child.on("error", () => {});
  child.unref();
}
export interface StartTelemetryOptions {
  command: TelemetryCommand;
  env: TelemetryEnvironment;
  scanMode?: "staged" | "base";
  outputFormat?: TelemetryEvent["output_format"];
  hookInvocation?: boolean;
  store?: TelemetryStore;
  notice?: () => void;
  launch?: () => void;
  send?: TelemetrySend;
}
export function startTelemetry(
  options: StartTelemetryOptions,
): CommandTelemetry {
  try {
    return createTelemetry(options);
  } catch {
    return NOOP;
  }
}
function createTelemetry(options: StartTelemetryOptions): CommandTelemetry {
  const { env, command } = options;
  if (telemetryDisabled(env)) return NOOP;
  const store = options.store ?? new TelemetryStore(telemetryDirectory(env));
  const context = telemetryContext(env);
  let state = store.read();
  if (state?.enabled === false) return NOOP;
  const notice =
    options.notice ??
    (() => {
      process.stderr.write(TELEMETRY_NOTICE);
    });
  const ci = context.environment === "ci";
  if (ci) {
    if (state?.notice_version !== 1) notice();
  } else state = store.initialize(notice);
  if (state?.enabled === false || (!ci && !state?.installation_id)) return NOOP;
  const controller = new AbortController();
  const send = options.send ?? sendTelemetry;
  const started = performance.now();
  const base = {
    schema_version: 1 as const,
    run_id: randomUUID(),
    version: ZEDBEE_VERSION,
    os: (["darwin", "linux", "win32"].includes(process.platform)
      ? process.platform
      : "other") as TelemetryEvent["os"],
    arch: (["x64", "arm64", "ia32", "arm"].includes(process.arch)
      ? process.arch
      : "other") as TelemetryEvent["arch"],
    node_major: Number(process.versions.node.split(".")[0]),
    command,
    ...context,
    invocation_source: options.hookInvocation
      ? ("git_hook" as const)
      : ("unspecified" as const),
    ...(ci
      ? { ci_execution_id: randomUUID() }
      : { installation_id: state!.installation_id! }),
    ...(command === "scan" ? { scan_mode: options.scanMode ?? "staged" } : {}),
    ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
  };
  let summary: TelemetrySummary = {};
  let finished = false;
  let pending = Promise.resolve();
  const allowed = () => {
    try {
      return !telemetryDisabled(env) && store.read()?.enabled !== false;
    } catch {
      return false;
    }
  };
  const emit = (
    event: TelemetryEvent["event"],
    details: TelemetrySummary & { duration_ms?: number } = {},
  ) => {
    try {
      if (!allowed()) return;
      const value = telemetryEventSchema.parse({
        ...base,
        ...details,
        event,
        event_id: randomUUID(),
        timestamp: new Date().toISOString(),
      });
      if (ci) {
        pending = pending
          .then(async () => {
            if (!controller.signal.aborted && allowed())
              await send([value], controller.signal);
          })
          .catch(() => {});
      } else {
        store.enqueue(value);
        (options.launch ?? (() => launchTelemetrySender(env)))();
      }
    } catch {
      /* Telemetry cannot affect a command. */
    }
  };
  if (command === "scan") emit("scan_started");
  return {
    summary(value) {
      // Only explicit metadata fields cross this boundary, even for untyped callers.
      try {
        for (const key of [
          "empty_input",
          "check_ids",
          "finding_count",
          "applied_count",
          "skipped_count",
          "profile",
          "hook",
          "outcome",
        ] as const) {
          if (value[key] !== undefined)
            Object.assign(summary, { [key]: value[key] });
        }
      } catch {}
    },
    finish(code) {
      if (finished) return;
      finished = true;
      const cancelled = code === 130 || code === 143;
      const outcome = cancelled
        ? "cancelled"
        : code === 2
          ? "incomplete"
          : command === "scan"
            ? code === 1
              ? "blocked"
              : "pass"
            : (summary.outcome ??
              (command === "fix" ? "preview" : "completed"));
      const event =
        command === "scan"
          ? "scan_finished"
          : command === "fix"
            ? "fix_finished"
            : command === "init"
              ? "setup_finished"
              : "command_finished";
      emit(event, {
        ...summary,
        outcome,
        duration_ms: Math.min(
          604_800_000,
          Math.max(0, Math.round(performance.now() - started)),
        ),
      });
    },
    async flush(cancelled, signal) {
      if (!ci) return;
      if (cancelled || signal?.aborted) {
        controller.abort();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        await Promise.race([
          pending,
          new Promise<void>((resolve) => {
            onAbort = () => {
              controller.abort();
              resolve();
            };
            signal?.addEventListener("abort", onAbort, { once: true });
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        controller.abort();
      }
    },
  };
}
