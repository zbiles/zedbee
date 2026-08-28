import { isAbsolute, relative, resolve } from "node:path";
import { buildFixPlan, renderFixPlanJson } from "../fixes/build-plan.js";
import { applyFixPlan } from "../fixes/apply-plan.js";
import {
  FIXABLE_CHECK_IDS,
  FIX_PLAN_FILE_SUMMARY_LIMIT,
  type FixPlan,
  type FixResult,
  type FixableCheckId,
  type PreparedFixPlan,
} from "../fixes/types.js";
import { displayProse } from "../core/display-text.js";
import { GitClient } from "../git/client.js";
import { opaqueTemporaryReportPath } from "../reporting/report-path.js";
import {
  createTemporaryReportStore,
  type ReportMaintenanceWarning,
  type TemporaryReportStore,
} from "../reporting/temporary-reports.js";

const COMPACT_DETAIL_LIMIT = 25;

export interface FixCommandOptions {
  readonly cwd: string;
  readonly check?: FixableCheckId;
  readonly yes: boolean;
  readonly format: "auto" | "text" | "json";
  readonly configPath?: string;
  readonly color: boolean;
  readonly animations: boolean;
  readonly signal?: AbortSignal;
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
  applyFixPlan(plan: PreparedFixPlan): Promise<FixResult>;
  /** Injected by the interactive UI task; the command remains safe until then. */
  confirm(plan: FixPlan, options: FixPromptOptions): Promise<boolean>;
  store: TemporaryReportStore;
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
  store: createTemporaryReportStore(),
};

export function parseFixCheck(value: string): FixableCheckId {
  if (FIXABLE_CHECK_IDS.includes(value as FixableCheckId)) {
    return value as FixableCheckId;
  }
  throw new TypeError("Expected a supported managed fix check selector.");
}

function validConfigPath(
  repositoryRoot: string,
  requested: string,
): string | undefined {
  const candidate = resolve(repositoryRoot, requested);
  const fromRoot = relative(repositoryRoot, candidate);
  if (
    !candidate.endsWith(".jsonc") ||
    fromRoot === "" ||
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`)
  ) {
    return undefined;
  }
  return candidate;
}

function formatFor(options: FixCommandOptions): "text" | "json" {
  return options.format === "json" ? "json" : "text";
}

function safeText(value: unknown, field: string): string {
  try {
    return displayProse(value, field);
  } catch {
    return "unavailable";
  }
}

function renderPlanText(plan: FixPlan, reportPath?: string): string {
  const lines = [
    "Zedbee managed fix plan.",
    `Checks: ${plan.selectedChecks.join(", ")}`,
    `Fixes: ${plan.summary.fixes} across ${plan.summary.files} files`,
    `Blocking: ${plan.summary.blocking}; warnings: ${plan.summary.warnings}; skipped: ${plan.summary.skipped}`,
  ];
  const items = plan.items.slice(0, COMPACT_DETAIL_LIMIT);
  for (const item of items) {
    lines.push(
      `${item.checkId}: ${JSON.stringify(safeText(item.file, "fix file"))} (${item.scope}, ${item.findingIds.length} fixes)`,
    );
  }
  if (plan.items.length > items.length) {
    lines.push(
      `Showing ${items.length} of ${plan.items.length} planned fixes.`,
    );
  }
  if (reportPath !== undefined) {
    lines.push(`Complete plan: ${opaqueTemporaryReportPath(reportPath)}`);
  }
  return `${lines.join("\n")}\n`;
}

function publicPlan(plan: FixPlan, applied: boolean, result?: FixResult) {
  const rendered = JSON.parse(renderFixPlanJson(plan)) as FixPlan;
  return {
    applied,
    schemaVersion: rendered.schemaVersion,
    target: rendered.target,
    selectedChecks: [...rendered.selectedChecks],
    exitCode: rendered.exitCode,
    summary: {
      fixes: rendered.summary.fixes,
      files: rendered.summary.files,
      blocking: rendered.summary.blocking,
      warnings: rendered.summary.warnings,
      skipped: rendered.summary.skipped,
    },
    files: rendered.files.map((file) => ({
      path: file.path,
      fixes: file.fixes,
      hasUnstagedChanges: file.hasUnstagedChanges,
    })),
    items: rendered.items.map((item) => ({
      checkId: item.checkId,
      file: item.file,
      findingIds: [...item.findingIds],
      scope: item.scope,
      blocking: item.blocking,
      warnings: item.warnings,
    })),
    ...(result === undefined
      ? {}
      : {
          result: {
            exitCode: result.exitCode,
            appliedFixes: result.appliedFixes,
            changedFiles: [...result.changedFiles],
            unchangedFiles: [...result.unchangedFiles],
            issues: result.issues.map((issue) => ({
              kind: issue.kind,
              file: issue.file,
              checkIds: [...issue.checkIds],
              message: issue.message,
              remediation: issue.remediation,
            })),
          },
        }),
  };
}

function renderResultText(result: FixResult): string {
  const lines = [
    result.exitCode === 0
      ? "Zedbee managed fixes applied."
      : "Zedbee managed fixes partially applied.",
    `Applied fixes: ${result.appliedFixes}`,
    `Changed files: ${result.changedFiles.length}`,
    `Unchanged files: ${result.unchangedFiles.length}`,
  ];
  for (const issue of result.issues) {
    lines.push(
      `${issue.kind}: ${JSON.stringify(safeText(issue.file, "fix file"))} — ${safeText(issue.message, "fix issue")}`,
      `Remediation: ${safeText(issue.remediation, "fix remediation")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderWarnings(warnings: readonly ReportMaintenanceWarning[]): string {
  if (warnings.length === 0) return "";
  return `${warnings
    .flatMap((warning) => [
      "FIX PLAN MAINTENANCE WARNING",
      safeText(warning.code.replaceAll("_", " "), "warning code"),
      `Issue: ${safeText(warning.message, "warning message")}`,
      ...(warning.path === undefined
        ? []
        : [`Path: ${opaqueTemporaryReportPath(warning.path)}`]),
    ])
    .join("\n")}\n`;
}

async function maintainPlan(
  plan: PreparedFixPlan,
  store: TemporaryReportStore,
): Promise<{
  readonly reportPath?: string;
  readonly warnings: readonly ReportMaintenanceWarning[];
}> {
  const json =
    plan.publicPlan.items.length > COMPACT_DETAIL_LIMIT ||
    plan.publicPlan.files.length > FIX_PLAN_FILE_SUMMARY_LIMIT
      ? renderFixPlanJson(plan.publicPlan)
      : undefined;
  try {
    return await store.maintain({
      repositoryRoot: plan.repositoryRoot,
      maxAgeMs: plan.temporaryReportMaxAgeMs,
      ...(json === undefined ? {} : { json }),
    });
  } catch {
    return {
      warnings: [
        {
          code: "TEMP_REPORT_WRITE_FAILED",
          message: "The temporary fix plan could not be maintained.",
        },
      ],
    };
  }
}

export async function executeFixCommand(
  options: FixCommandOptions,
  io: FixCommandIO,
  dependencies: FixCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<0 | 1 | 2> {
  try {
    options.signal?.throwIfAborted();
    const repositoryRoot = await dependencies.resolveRepositoryRoot(
      options.cwd,
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
    const prepared = await dependencies.buildFixPlan({
      repositoryRoot,
      selectedChecks:
        options.check === undefined ? FIXABLE_CHECK_IDS : [options.check],
      ...(configPath === undefined ? {} : { configPath }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const maintenance = await maintainPlan(prepared, dependencies.store);
    const format = formatFor(options);
    const outputPlan = (applied: boolean, result?: FixResult): void => {
      if (format === "json") {
        io.writeStdout(
          `${JSON.stringify(publicPlan(prepared.publicPlan, applied, result), null, 2)}\n`,
        );
      } else {
        io.writeStdout(
          renderPlanText(prepared.publicPlan, maintenance.reportPath),
        );
      }
    };

    if (prepared.publicPlan.exitCode === 2) {
      outputPlan(false);
      io.writeStderr(renderWarnings(maintenance.warnings));
      return 2;
    }

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
        outputPlan(false);
        io.writeStdout("Zedbee fix cancelled.\n");
        io.writeStderr(renderWarnings(maintenance.warnings));
        return 0;
      }
    }

    if (!confirmed) {
      outputPlan(false);
      if (format === "text") {
        io.writeStdout("Run zedbee fix --yes to apply this plan.\n");
      }
      io.writeStderr(renderWarnings(maintenance.warnings));
      return 0;
    }

    options.signal?.throwIfAborted();
    const result = await dependencies.applyFixPlan(prepared);
    if (format === "json") {
      outputPlan(true, result);
    } else {
      io.writeStdout(renderResultText(result));
    }
    io.writeStderr(renderWarnings(maintenance.warnings));
    return result.exitCode;
  } catch {
    if (options.signal?.aborted === true) {
      io.writeStderr("Zedbee fix was interrupted.\n");
    } else {
      io.writeStderr("Zedbee could not complete the managed fix.\n");
    }
    return 2;
  }
}
