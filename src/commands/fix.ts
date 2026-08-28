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
const MINIMUM_RESULT_DASHBOARD_WIDTH = 80;

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
  const fixLabel = (count: number): string =>
    `${count} ${count === 1 ? "fix" : "fixes"}`;
  const fileLabel = (count: number): string =>
    `${count} ${count === 1 ? "file" : "files"}`;
  const fixesFor = (item: FixPlan["items"][number]): number =>
    item.fixes ?? (item.scope === "finding" ? item.findingIds.length : 1);
  const lines = [
    "Zedbee managed fix plan.",
    `Checks: ${plan.selectedChecks.join(", ")}`,
    `${fixLabel(plan.summary.fixes)} across ${fileLabel(plan.summary.files)}`,
    `Blocking: ${plan.summary.blocking}; warnings: ${plan.summary.warnings}; skipped: ${plan.summary.skipped}`,
  ];
  for (const check of plan.checks ?? []) {
    if (check.status === "completed") {
      lines.push(
        `${check.checkId}: READY — ${fixLabel(check.fixes)} available`,
      );
      continue;
    }
    if (check.status === "not-applicable") {
      lines.push(
        `${check.checkId}: NOT APPLICABLE — ${safeText(check.reason, "check reason")}`,
      );
      continue;
    }
    lines.push(`${check.checkId}: INCOMPLETE`);
    for (const issue of check.issues) {
      lines.push(
        `Issue: ${safeText(issue.code.replaceAll("_", " "), "check error code")} — ${safeText(issue.message, "check error")}`,
        ...(issue.path === undefined
          ? []
          : [
              `Path: ${JSON.stringify(safeText(issue.path, "check error path"))}`,
            ]),
        ...(issue.remediation === undefined
          ? []
          : [
              `Remediation: ${safeText(issue.remediation, "check remediation")}`,
            ]),
      );
    }
  }
  const items = plan.items.slice(0, COMPACT_DETAIL_LIMIT);
  for (const item of items) {
    if (item.status === "skipped") {
      lines.push(
        `SKIP: ${JSON.stringify(safeText(item.file, "fix file"))} — ${safeText(item.reason, "skip reason")}`,
      );
    } else {
      lines.push(
        `${item.checkId}: ${JSON.stringify(safeText(item.file, "fix file"))} (${item.scope}, ${fixLabel(fixesFor(item))})`,
      );
    }
  }
  if (plan.items.length > items.length) {
    lines.push(
      `Showing ${items.reduce((total, item) => total + fixesFor(item), 0)} of ${plan.summary.fixes} planned fixes.`,
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
    ...(rendered.checks === undefined
      ? {}
      : {
          checks: rendered.checks.map((check) => ({
            checkId: check.checkId,
            status: check.status,
            fixes: check.fixes,
            issues: check.issues.map((issue) => ({
              code: issue.code,
              message: issue.message,
              ...(issue.path === undefined ? {} : { path: issue.path }),
              ...(issue.remediation === undefined
                ? {}
                : { remediation: issue.remediation }),
            })),
            ...(check.reason === undefined ? {} : { reason: check.reason }),
          })),
        }),
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
      ...(file.applicableFixes === undefined
        ? {}
        : { applicableFixes: file.applicableFixes }),
      ...(file.skippedFixes === undefined
        ? {}
        : { skippedFixes: file.skippedFixes }),
      ...(file.status === undefined ? {} : { status: file.status }),
      ...(file.reasons === undefined ? {} : { reasons: [...file.reasons] }),
      hasUnstagedChanges: file.hasUnstagedChanges,
    })),
    items: rendered.items.map((item) => ({
      checkId: item.checkId,
      file: item.file,
      findingIds: [...item.findingIds],
      scope: item.scope,
      ...(item.fixes === undefined ? {} : { fixes: item.fixes }),
      blocking: item.blocking,
      warnings: item.warnings,
      ...(item.status === undefined ? {} : { status: item.status }),
      ...(item.reason === undefined ? {} : { reason: item.reason }),
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

function renderResultText(plan: FixPlan, result: FixResult): string {
  const lines = [
    result.exitCode === 0 && plan.exitCode === 0
      ? "Zedbee managed fixes applied."
      : "Zedbee managed fixes partially applied.",
    `Applied fixes: ${result.appliedFixes}`,
    `Changed files: ${result.changedFiles.length}`,
    `Unchanged files: ${result.unchangedFiles.length}`,
    `Plan findings: ${plan.summary.blocking} blocking; ${plan.summary.warnings} ${plan.summary.warnings === 1 ? "warning" : "warnings"}`,
  ];
  for (const check of plan.checks ?? []) {
    if (check.status === "completed") {
      lines.push(
        `${check.checkId}: READY — ${check.fixes} ${check.fixes === 1 ? "fix" : "fixes"} available`,
      );
    } else if (check.status === "incomplete") {
      lines.push(`${check.checkId}: INCOMPLETE`);
      for (const issue of check.issues) {
        lines.push(
          `Issue: ${safeText(issue.code.replaceAll("_", " "), "check error code")} — ${safeText(issue.message, "check error")}`,
          ...(issue.path === undefined
            ? []
            : [
                `Path: ${JSON.stringify(safeText(issue.path, "check error path"))}`,
              ]),
          ...(issue.remediation === undefined
            ? []
            : [
                `Remediation: ${safeText(issue.remediation, "check remediation")}`,
              ]),
        );
      }
    } else if (check.status === "not-applicable") {
      lines.push(
        `${check.checkId}: NOT APPLICABLE — ${safeText(check.reason, "check reason")}`,
      );
    }
  }
  for (const issue of result.issues) {
    lines.push(
      `${issue.kind}: ${JSON.stringify(safeText(issue.file, "fix file"))} — ${safeText(issue.message, "fix issue")}`,
      `Remediation: ${safeText(issue.remediation, "fix remediation")}`,
    );
  }
  lines.push(
    "Next step: Review Zedbee's changes, stage the ones you want to keep, then run zedbee scan to verify the updated staged code and identify remaining findings.",
  );
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
  persistCompletePlan: boolean,
): Promise<{
  readonly reportPath?: string;
  readonly warnings: readonly ReportMaintenanceWarning[];
}> {
  const json =
    persistCompletePlan &&
    (plan.publicPlan.items.length > COMPACT_DETAIL_LIMIT ||
      plan.publicPlan.files.length > FIX_PLAN_FILE_SUMMARY_LIMIT)
      ? renderFixPlanJson(plan.publicPlan)
      : undefined;
  try {
    return await store.maintain({
      repositoryRoot: plan.repositoryRoot,
      maxAgeMs: plan.temporaryReportMaxAgeMs,
      reportKind: "fix-plan",
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
    const format = formatFor(options);
    const maintenance = await maintainPlan(
      prepared,
      dependencies.store,
      format === "text",
    );
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

    const hasApplicableFixes =
      prepared.publicPlan.items.some((item) => item.status !== "skipped") ||
      prepared.publicPlan.exitCode !== 1;

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
        io.writeStdout(
          hasApplicableFixes
            ? "Zedbee fix cancelled.\n"
            : "Zedbee fix closed.\n",
        );
        io.writeStderr(renderWarnings(maintenance.warnings));
        return hasApplicableFixes ? 0 : prepared.publicPlan.exitCode;
      }
    }

    if (!confirmed) {
      outputPlan(false);
      if (format === "text") {
        io.writeStdout(
          hasApplicableFixes
            ? "Run zedbee fix --yes to apply this plan.\n"
            : "No trustworthy managed fixes are available to apply.\n",
        );
      }
      io.writeStderr(renderWarnings(maintenance.warnings));
      return hasApplicableFixes ? 0 : prepared.publicPlan.exitCode;
    }

    if (!hasApplicableFixes) {
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
    const result = await dependencies.applyFixPlan(prepared);
    if (format === "json") {
      outputPlan(true, result);
    } else if (
      options.format === "auto" &&
      io.stdoutIsTTY &&
      io.width >= MINIMUM_RESULT_DASHBOARD_WIDTH &&
      io.env.TERM !== "dumb" &&
      io.env.CI === undefined
    ) {
      await (dependencies.renderResultDashboard ?? renderResultDashboard)(
        prepared.publicPlan,
        result,
        {
          width: io.width,
          color: options.color && io.env.NO_COLOR === undefined,
        },
      );
    } else {
      io.writeStdout(renderResultText(prepared.publicPlan, result));
    }
    io.writeStderr(renderWarnings(maintenance.warnings));
    return Math.max(result.exitCode, prepared.publicPlan.exitCode) as 0 | 1;
  } catch {
    if (options.signal?.aborted === true) {
      io.writeStderr("Zedbee fix was interrupted.\n");
    } else {
      io.writeStderr("Zedbee could not complete the managed fix.\n");
    }
    return 2;
  }
}
