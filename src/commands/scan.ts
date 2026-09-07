import { extname, isAbsolute, relative, resolve } from "node:path";
import { GitClient } from "../git/client.js";
import { renderJson } from "../renderers/json.js";
import { renderSarif } from "../renderers/sarif.js";
import { renderText } from "../renderers/text.js";
import { terminalColorEnabled } from "../renderers/terminal-style.js";
import {
  prepareTerminalPresentation,
  type PreparePresentationOptions,
  type TerminalPresentation,
} from "../reporting/presentation.js";
import {
  createTemporaryReportStore,
  type ReportMaintenanceWarning,
} from "../reporting/temporary-reports.js";
import { opaqueTemporaryReportPath } from "../reporting/report-path.js";
import { runScan, type RunScanOptions } from "../scan/run-scan.js";
import type { ScanReport } from "../scan/report.js";
import type { ScanEvent } from "../checks/events.js";
import { hasAnalysisCleanupFailure } from "../scan/analysis-failure.js";
import {
  writeCommandDiagnostics,
  SNAPSHOT_CLEANUP_WARNING,
  type DiagnosticEntry,
  timeCommandStage,
  type DiagnosticTimings,
} from "./diagnostics.js";
import type {
  ReportingSurface,
  RequestedOutputFormat,
  SourceExcerptOverride,
} from "../scan/reporting-options.js";

export type { RequestedOutputFormat } from "../scan/reporting-options.js";
export type OutputFormat = ReportingSurface;

export interface ScanCommandOptions {
  cwd: string;
  format: RequestedOutputFormat;
  color: boolean;
  animations: boolean;
  baseRef?: string;
  configPath?: string;
  sourceExcerpts?: SourceExcerptOverride;
  timeout?: string;
  noTimeout?: boolean;
  diagnostics?: boolean;
  signal?: AbortSignal;
}

export interface ScanCommandIO {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  width: number;
  env: Record<string, string | undefined>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface InkRenderOptions {
  requestedFormat: "auto" | "ink";
  color: boolean;
  animations: boolean;
  width: number;
}

export interface ScanCommandDependencies {
  resolveRepositoryRoot(cwd: string): Promise<string>;
  scan(options: RunScanOptions): Promise<ScanReport>;
  openInk(options: InkRenderOptions, onError: () => void): Promise<InkSession>;
  preparePresentation(
    report: ScanReport,
    options: Omit<PreparePresentationOptions, "store">,
  ): Promise<TerminalPresentation>;
}

/** Presentation observes controller-owned analysis and never prepares reports. */
export interface InkSession {
  update(event: ScanEvent): void;
  finish(report: ScanReport, presentation: TerminalPresentation): Promise<void>;
  close(): Promise<void>;
}

const TEMPORARY_REPORT_STORE = createTemporaryReportStore();

function renderMaintenanceWarnings(
  warnings: readonly ReportMaintenanceWarning[],
): string {
  if (warnings.length === 0) return "";
  return `${warnings
    .flatMap((warning) => [
      "REPORT MAINTENANCE WARNING",
      warning.code.replaceAll("_", " "),
      `Issue: ${warning.message}`,
      ...(warning.path === undefined
        ? []
        : [`Path: ${opaqueTemporaryReportPath(warning.path)}`]),
    ])
    .join("\n")}\n`;
}

function writeMaintenanceWarnings(
  io: ScanCommandIO,
  warnings: readonly ReportMaintenanceWarning[],
): void {
  const output = renderMaintenanceWarnings(warnings);
  if (output !== "") io.writeStderr(output);
}

function writeGitSoftTimeoutWarning(io: ScanCommandIO): void {
  io.writeStderr(
    "GIT SOFT TIMEOUT\nA Git command is still running after resources.git.softTimeout. Zedbee is waiting for it to finish.\n",
  );
}

export function selectOutputFormat(
  requested: RequestedOutputFormat,
  _stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
  width?: number,
  env: Readonly<Record<string, string | undefined>> = {},
): OutputFormat {
  if (requested !== "auto") {
    return requested;
  }
  return usesLinearAutomaticOutput(stdoutIsTTY, width, env) ? "text" : "ink";
}

function positiveTerminalWidth(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : undefined;
}

export function normalizeTerminalWidth(value: unknown): number {
  return positiveTerminalWidth(value) ?? 80;
}

function isTruthyEnvironmentValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return !["", "0", "false", "no", "off"].includes(normalized);
}

function usesLinearAutomaticOutput(
  stdoutIsTTY: boolean,
  width: number | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const knownWidth = positiveTerminalWidth(width);
  return (
    !stdoutIsTTY ||
    (knownWidth !== undefined && knownWidth < 80) ||
    isTruthyEnvironmentValue(env.CI) ||
    env.TERM === "dumb" ||
    env.INK_SCREEN_READER === "true"
  );
}

export function signalExitCode(signal: "SIGINT" | "SIGTERM"): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

function validConfigPath(
  repositoryRoot: string,
  requested: string,
): string | undefined {
  const candidate = resolve(repositoryRoot, requested);
  const fromRoot = relative(repositoryRoot, candidate);
  if (
    extname(candidate) !== ".jsonc" ||
    fromRoot === "" ||
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    return undefined;
  }
  return candidate;
}

const DEFAULT_DEPENDENCIES: ScanCommandDependencies = {
  async resolveRepositoryRoot(cwd) {
    return (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"]))
      .stdout;
  },
  scan: runScan,
  async openInk(options, onError) {
    const { openInkSession } = await import("../ui/render-ink.js");
    return openInkSession(options, onError);
  },
  async preparePresentation(report, options) {
    return prepareTerminalPresentation(report, {
      ...options,
      store: TEMPORARY_REPORT_STORE,
    });
  },
};

export async function executeScanCommand(
  options: ScanCommandOptions,
  io: ScanCommandIO,
  dependencies: ScanCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<0 | 1 | 2> {
  const started = performance.now();
  const stages: DiagnosticTimings = {};
  let diagnosticEntries: readonly DiagnosticEntry[] = [];
  let cleanupFailed = false;
  let session: InkSession | undefined;
  let renderingFailed = false;
  const close = async (): Promise<void> => {
    const active = session;
    session = undefined;
    try {
      await active?.close();
    } catch {
      renderingFailed = true;
    }
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

    const format = selectOutputFormat(
      options.format,
      io.stdinIsTTY,
      io.stdoutIsTTY,
      io.width,
      io.env,
    );
    const scanOptions: RunScanOptions = {
      repositoryRoot,
      reportingSurface: format,
      ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
      ...(options.sourceExcerpts === undefined
        ? {}
        : { sourceExcerpts: options.sourceExcerpts }),
      ...(configPath === undefined ? {} : { configPath }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.noTimeout ? { noTimeout: true } : {}),
      onEvent(event) {
        // Event observers must never change the analyzer outcome.
        try {
          if (format === "ink" && !renderingFailed) session?.update(event);
          else if (event.type === "git-soft-timeout")
            writeGitSoftTimeoutWarning(io);
        } catch {
          if (format === "ink") renderingFailed = true;
        }
      },
    };
    const color = options.color && io.env.NO_COLOR === undefined;
    const requestedInkFormat: InkRenderOptions["requestedFormat"] =
      options.format === "auto" ? "auto" : "ink";
    const inkOptions = {
      requestedFormat: requestedInkFormat,
      color,
      animations: options.animations,
      width: io.width,
    };

    if (format === "ink") {
      try {
        session = await dependencies.openInk(inkOptions, () => {
          renderingFailed = true;
        });
      } catch {
        renderingFailed = true;
      }
    }

    const report = await timeCommandStage(stages, "analysis", () =>
      dependencies.scan(scanOptions),
    );
    diagnosticEntries = report.checks.map((check) => ({
      durationMs: check.durationMs,
      checkId: check.checkId,
      status: check.status,
      ...(check.error?.diagnostic === undefined
        ? {}
        : { diagnostic: check.error.diagnostic }),
    }));
    options.signal?.throwIfAborted();
    const presentation = await timeCommandStage(stages, "report", () =>
      dependencies.preparePresentation(report, {
        requestedFormat: options.format,
        selectedFormat: format,
      }),
    );

    if (format === "json") {
      const json = renderJson(report);
      io.writeStdout(json);
      writeMaintenanceWarnings(io, presentation.warnings);
    } else if (format === "sarif") {
      const sarif = renderSarif(report);
      io.writeStdout(`${sarif}\n`);
      writeMaintenanceWarnings(io, presentation.warnings);
    } else if (format === "text") {
      io.writeStdout(
        renderText(report, {
          width: io.width,
          color: terminalColorEnabled(options.color, io.stdoutIsTTY, io.env),
          presentation,
        }),
      );
    } else {
      if (!renderingFailed) {
        try {
          await session?.finish(report, presentation);
        } catch {
          renderingFailed = true;
        }
      }
      await close();
      options.signal?.throwIfAborted();
      if (renderingFailed) {
        io.writeStdout(
          renderText(report, {
            width: io.width,
            color: terminalColorEnabled(options.color, io.stdoutIsTTY, io.env),
            presentation: {
              ...presentation,
              automatic: false,
              findings: report.summary.findings,
              abbreviated: false,
            },
          }),
        );
      }
    }
    return report.exitCode;
  } catch (error) {
    cleanupFailed = hasAnalysisCleanupFailure(error);
    if (cleanupFailed) io.writeStderr(SNAPSHOT_CLEANUP_WARNING);
    if (options.signal?.aborted === true) {
      return 2;
    }
    io.writeStderr("Zedbee could not complete the scan.\n");
    return 2;
  } finally {
    await close();
    if (options.diagnostics)
      writeCommandDiagnostics(io, {
        command: "scan",
        durationMs: performance.now() - started,
        stages,
        entries: diagnosticEntries,
        cancelled: options.signal?.aborted === true,
        cleanupFailed,
        renderingFailed,
      });
  }
}
