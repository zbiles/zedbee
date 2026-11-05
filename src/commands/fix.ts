import {
  renderPlanText,
  cleanupFailureDetails,
  publicPlan,
  renderResultText,
  renderWarnings,
} from "../reporting/fix-presentation.js";
import { maintainPlan } from "../reporting/fix-plan-store.js";
import type { TelemetrySummary } from "../telemetry/client.js";
import { validConfigPath } from "../config/selection-path.js";
import { buildFixPlan } from "../fixes/build-plan.js";
import { applyFixPlan, FixApplyCleanupError } from "../fixes/apply-plan.js";
import { createCommandExecutor } from "./executor.js";
import type { AnalyzerExecutor } from "../checks/runner/executor.js";
import { AnalysisSessionCleanupError } from "../scan/analysis-failure.js";
import {
  writeCommandDiagnostics,
  SNAPSHOT_CLEANUP_WARNING,
  type DiagnosticEntry,
  timeCommandStage,
  type DiagnosticTimings,
} from "./diagnostics.js";
import {
  FIXABLE_CHECK_IDS,
  type FixPlan,
  type FixResult,
  type FixableCheckId,
  type PreparedFixPlan,
} from "../fixes/types.js";
import { hasApplicableFixes } from "../fixes/availability.js";
import { GitClient } from "../git/client.js";
import { opaqueTemporaryReportPath } from "../reporting/report-path.js";
import {
  createTemporaryReportStore,
  type TemporaryReportStore,
} from "../reporting/temporary-reports.js";
import { terminalColorEnabled } from "../renderers/terminal-style.js";

const MINIMUM_RESULT_DASHBOARD_WIDTH = 80;

export interface FixCommandOptions {
  readonly telemetrySummary?: (value: TelemetrySummary) => void;
  readonly service?: boolean;
  readonly executor?: AnalyzerExecutor;
  readonly cwd: string;
  readonly check?: FixableCheckId;
  readonly yes: boolean;
  readonly format: "auto" | "text" | "json";
  readonly configPath?: string;
  readonly color: boolean;
  readonly animations: boolean;
  readonly signal?: AbortSignal;
  readonly diagnostics?: boolean;
  /** Invocation-only consent for project Prettier execution. */
  readonly projectPrettierTrust?: boolean;
}

export interface FixCommandIO {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly width: number;
  readonly env: Record<string, string | undefined>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface FixPromptOptions {
  readonly width: number;
  readonly color: boolean;
  readonly animations: boolean;
  readonly signal?: AbortSignal;
  /** Opaque temporary report location, when a complete plan was persisted. */
  readonly reportPath?: string;
}

export interface FixCommandDependencies {
  resolveRepositoryRoot(cwd: string): Promise<string>;
  buildFixPlan(
    options: Parameters<typeof buildFixPlan>[0],
  ): Promise<PreparedFixPlan>;
  applyFixPlan(
    plan: PreparedFixPlan,
    options?: {
      readonly signal?: AbortSignal;
      readonly executor?: AnalyzerExecutor;
      /** Invocation-only consent carried in memory, never the serialized plan. */
      readonly projectPrettierTrust?: boolean;
    },
  ): Promise<FixResult>;
  /** Injected by the interactive UI task; the command remains safe until then. */
  confirm(plan: FixPlan, options: FixPromptOptions): Promise<boolean>;
  renderResultDashboard?(
    plan: FixPlan,
    result: FixResult,
    options: { readonly width: number; readonly color: boolean },
  ): Promise<void>;
  store: TemporaryReportStore;
}

async function renderResultDashboard(
  plan: FixPlan,
  result: FixResult,
  options: { readonly width: number; readonly color: boolean },
): Promise<void> {
  const { runInkFixResult } = await import("../ui/fix-result-dashboard.js");
  await runInkFixResult(plan, result, options);
}

const DEFAULT_DEPENDENCIES: FixCommandDependencies = {
  async resolveRepositoryRoot(cwd) {
    return (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"]))
      .stdout;
  },
  buildFixPlan,
  applyFixPlan,
  async confirm(plan, options) {
    const { runFixPrompt } = await import("../ui/fix-app.js");
    return runFixPrompt(plan, options);
  },
  renderResultDashboard,
  store: createTemporaryReportStore(),
};

export function parseFixCheck(value: string): FixableCheckId {
  if (FIXABLE_CHECK_IDS.includes(value as FixableCheckId)) {
    return value as FixableCheckId;
  }
  throw new TypeError("Expected a supported managed fix check selector.");
}

function formatFor(options: FixCommandOptions): "text" | "json" {
  return options.format === "json" ? "json" : "text";
}

function cleanupDiagnosis(
  error: unknown,
): AnalysisSessionCleanupError | undefined {
  if (error instanceof AnalysisSessionCleanupError) return error;
  if (!(error instanceof Error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "cleanupFailure");
  return descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.value instanceof AnalysisSessionCleanupError
    ? descriptor.value
    : undefined;
}

export async function executeFixCommand(
  options: FixCommandOptions,
  io: FixCommandIO,
  dependencies: FixCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<0 | 1 | 2> {
  const started = performance.now();
  const stages: DiagnosticTimings = {};
  const diagnosticEntries: DiagnosticEntry[] = [];
  let cleanupFailed = false;
  let applying: PreparedFixPlan | undefined;
  let appliedResult: FixResult | undefined;
  const executor = options.executor ?? createCommandExecutor(options.service);
  const closeExecutor = () =>
    options.executor === undefined ? executor.close() : Promise.resolve();
  const summarize = (value: TelemetrySummary) => {
    try {
      options.telemetrySummary?.(value);
    } catch {}
  };
  try {
    options.signal?.throwIfAborted();
    const repositoryRoot = await timeCommandStage(stages, "repository", () =>
      dependencies.resolveRepositoryRoot(options.cwd),
    );
    const configPath =
      options.configPath === undefined
        ? undefined
        : validConfigPath(repositoryRoot, options.configPath);
    if (options.configPath !== undefined && configPath === undefined) {
      io.writeStderr(
        "Zedbee configuration must be a .jsonc file inside the repository.\n",
      );
      return 2;
    }
    const prepared = await timeCommandStage(stages, "analysis", () =>
      dependencies.buildFixPlan({
        executor,
        repositoryRoot,
        selectedChecks:
          options.check === undefined ? FIXABLE_CHECK_IDS : [options.check],
        ...(configPath === undefined ? {} : { configPath }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.projectPrettierTrust === true
          ? { projectPrettierTrust: true }
          : {}),
      }),
    );
    summarize({
      check_ids: [...prepared.publicPlan.selectedChecks],
      skipped_count: Math.min(1_000_000, prepared.publicPlan.summary.skipped),
    });
    const format = formatFor(options);
    diagnosticEntries.push(
      ...(prepared.publicPlan.checks ?? []).flatMap((check) => check.issues),
    );
    const maintenance = await timeCommandStage(stages, "report", () =>
      maintainPlan(prepared, dependencies.store, format === "text"),
    );
    const outputPlan = (applied: boolean, result?: FixResult): void => {
      if (format === "json") {
        io.writeStdout(
          `${JSON.stringify(publicPlan(prepared.publicPlan, applied, result), null, 2)}\n`,
        );
      } else {
        io.writeStdout(
          renderPlanText(
            prepared.publicPlan,
            maintenance.reportPath,
            terminalColorEnabled(options.color, io.stdoutIsTTY, io.env),
          ),
        );
      }
    };

    if (prepared.publicPlan.exitCode === 2) {
      await closeExecutor();
      outputPlan(false);
      io.writeStderr(renderWarnings(maintenance.warnings));
      return 2;
    }

    const applicableFixesAvailable = hasApplicableFixes(prepared.publicPlan);

    let confirmed = options.yes;
    if (!confirmed && format === "text" && io.stdinIsTTY && io.stdoutIsTTY) {
      confirmed = await dependencies.confirm(prepared.publicPlan, {
        width: io.width,
        color: options.color && io.env.NO_COLOR === undefined,
        animations: options.animations && io.env.NO_COLOR === undefined,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(maintenance.reportPath === undefined
          ? {}
          : { reportPath: maintenance.reportPath }),
      });
      if (!confirmed) {
        summarize({ outcome: "cancelled" });
        await closeExecutor();
        outputPlan(false);
        io.writeStdout(
          applicableFixesAvailable
            ? "Zedbee fix cancelled.\n"
            : "Zedbee fix closed.\n",
        );
        io.writeStderr(renderWarnings(maintenance.warnings));
        return applicableFixesAvailable ? 0 : prepared.publicPlan.exitCode;
      }
    }

    if (!confirmed) {
      await closeExecutor();
      outputPlan(false);
      if (format === "text") {
        io.writeStdout(
          applicableFixesAvailable
            ? "Run zedbee fix --yes to apply this plan.\n"
            : "No trustworthy managed fixes are available to apply.\n",
        );
      }
      io.writeStderr(renderWarnings(maintenance.warnings));
      return applicableFixesAvailable ? 0 : prepared.publicPlan.exitCode;
    }

    if (!applicableFixesAvailable) {
      await closeExecutor();
      outputPlan(false);
      if (format === "text") {
        io.writeStdout(
          "No trustworthy managed fixes are available to apply.\n",
        );
      }
      io.writeStderr(renderWarnings(maintenance.warnings));
      return prepared.publicPlan.exitCode;
    }

    options.signal?.throwIfAborted();
    applying = prepared;
    const result = await timeCommandStage(stages, "apply", () =>
      dependencies.applyFixPlan(prepared, {
        executor,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.projectPrettierTrust === true
          ? { projectPrettierTrust: true }
          : {}),
      }),
    );
    appliedResult = result;
    summarize({
      outcome: "applied",
      applied_count: Math.min(1_000_000, result.appliedFixes),
    });
    diagnosticEntries.push(...result.issues);
    await closeExecutor();
    if (format === "json") {
      outputPlan(true, result);
    } else if (
      options.format === "auto" &&
      io.stdoutIsTTY &&
      io.width >= MINIMUM_RESULT_DASHBOARD_WIDTH &&
      io.env.TERM !== "dumb" &&
      io.env.CI === undefined
    ) {
      try {
        await (dependencies.renderResultDashboard ?? renderResultDashboard)(
          prepared.publicPlan,
          result,
          {
            width: io.width,
            color: options.color && io.env.NO_COLOR === undefined,
          },
        );
      } catch {
        io.writeStdout(
          renderResultText(
            prepared.publicPlan,
            result,
            terminalColorEnabled(options.color, io.stdoutIsTTY, io.env),
          ),
        );
      }
    } else {
      io.writeStdout(
        renderResultText(
          prepared.publicPlan,
          result,
          terminalColorEnabled(options.color, io.stdoutIsTTY, io.env),
        ),
      );
    }
    io.writeStderr(renderWarnings(maintenance.warnings));
    return Math.max(result.exitCode, prepared.publicPlan.exitCode) as 0 | 1;
  } catch (error) {
    const cleanup = cleanupDiagnosis(error);
    cleanupFailed = cleanup !== undefined;
    const details =
      cleanup === undefined ? undefined : cleanupFailureDetails(cleanup);
    const retainedResult =
      cleanup instanceof FixApplyCleanupError ? cleanup.result : appliedResult;
    if (
      applying !== undefined &&
      cleanup !== undefined &&
      retainedResult !== undefined
    ) {
      summarize({
        applied_count: Math.min(1_000_000, retainedResult.appliedFixes),
      });
      if (appliedResult === undefined)
        diagnosticEntries.push(...retainedResult.issues);
      if (formatFor(options) === "json") {
        io.writeStdout(
          `${JSON.stringify(publicPlan(applying.publicPlan, true, retainedResult, details), null, 2)}\n`,
        );
      } else {
        io.writeStdout(
          renderResultText(
            applying.publicPlan,
            retainedResult,
            terminalColorEnabled(options.color, io.stdoutIsTTY, io.env),
          ),
        );
      }
    }
    if (cleanupFailed) {
      io.writeStderr(SNAPSHOT_CLEANUP_WARNING);
      if (details?.path !== undefined)
        io.writeStderr(`Path: ${opaqueTemporaryReportPath(details.path)}\n`);
      if (details !== undefined)
        io.writeStderr(`Remediation: ${details.remediation}\n`);
    }
    if (options.signal?.aborted === true) {
      io.writeStderr("Zedbee fix was interrupted.\n");
    } else {
      io.writeStderr("Zedbee could not complete the managed fix.\n");
    }
    return 2;
  } finally {
    try {
      await closeExecutor();
    } catch {
      if (!cleanupFailed) io.writeStderr(SNAPSHOT_CLEANUP_WARNING);
      cleanupFailed = true;
    }
    if (options.diagnostics)
      writeCommandDiagnostics(io, {
        command: "fix",
        durationMs: performance.now() - started,
        stages,
        entries: diagnosticEntries,
        cancelled: options.signal?.aborted === true,
        cleanupFailed,
      });
    if (cleanupFailed) return 2;
  }
}
