import { isAbsolute, relative, resolve } from "node:path";
import { buildFixPlan, renderFixPlanJson } from "../fixes/build-plan.js";
import { applyFixPlan } from "../fixes/apply-plan.js";
import { presentFixResult } from "../fixes/result-presentation.js";
import {
  FIXABLE_CHECK_IDS,
  FIX_PLAN_FILE_SUMMARY_LIMIT,
  type FixPlan,
  type FixResult,
  type FixableCheckId,
  type PreparedFixPlan,
} from "../fixes/types.js";
import { hasApplicableFixes } from "../fixes/availability.js";
import { displayProse } from "../core/display-text.js";
import { GitClient } from "../git/client.js";
import { opaqueTemporaryReportPath } from "../reporting/report-path.js";
import {
  createTemporaryReportStore,
  type ReportMaintenanceWarning,
  type TemporaryReportStore,
} from "../reporting/temporary-reports.js";
import {
  terminalColorEnabled,
  terminalText,
} from "../renderers/terminal-style.js";

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

function renderPlanText(
  plan: FixPlan,
  reportPath?: string,
  color = false,
): string {
  const fixLabel = (count: number): string =>
    `${count} ${count === 1 ? "fix" : "fixes"}`;
  const fileLabel = (count: number): string =>
    `${count} ${count === 1 ? "file" : "files"}`;
  const fixesFor = (item: FixPlan["items"][number]): number =>
    item.fixes ?? (item.scope === "finding" ? item.findingIds.length : 1);
  const lines = [
    terminalText("Zedbee managed fix plan.", "primary", color),
    terminalText(
      `Checks: ${plan.selectedChecks.join(", ")}`,
      "secondary",
      color,
    ),
    terminalText(
      `${fixLabel(plan.summary.fixes)} across ${fileLabel(plan.summary.files)}`,
      "secondary",
      color,
    ),
    terminalText(
      `Blocking: ${plan.summary.blocking}; warnings: ${plan.summary.warnings}; skipped: ${plan.summary.skipped}`,
      "secondary",
      color,
    ),
  ];
  for (const check of plan.checks ?? []) {
    lines.push("");
    if (check.status === "completed") {
      lines.push(
        `${terminalText(check.checkId, "primary", color)}${terminalText(": ", "secondary", color)}${terminalText("READY", "pass", color)}${terminalText(` — ${fixLabel(check.fixes)} available`, "secondary", color)}`,
      );
      continue;
    }
    if (check.status === "not-applicable") {
      lines.push(
        `${terminalText(check.checkId, "primary", color)}${terminalText(": NOT APPLICABLE — ", "secondary", color)}${terminalText(safeText(check.reason, "check reason"), "reason", color)}`,
      );
      continue;
    }
    lines.push(
      `${terminalText(check.checkId, "primary", color)}${terminalText(": ", "secondary", color)}${terminalText("INCOMPLETE", "failure", color)}`,
    );
    for (const issue of check.issues) {
      lines.push(
        terminalText(
          `Issue: ${safeText(issue.code.replaceAll("_", " "), "check error code")} — ${safeText(issue.message, "check error")}`,
          "secondary",
          color,
        ),
        ...(issue.path === undefined
          ? []
          : [
              terminalText(
                `Path: ${JSON.stringify(safeText(issue.path, "check error path"))}`,
                "secondary",
                color,
              ),
            ]),
        ...(issue.remediation === undefined
          ? []
          : [
              terminalText(
                `Remediation: ${safeText(issue.remediation, "check remediation")}`,
                "reason",
                color,
              ),
            ]),
      );
    }
  }
  if ((plan.checks?.length ?? 0) > 0 && plan.items.length > 0) lines.push("");
  const items = plan.items.slice(0, COMPACT_DETAIL_LIMIT);
  for (const item of items) {
    if (item.status === "skipped") {
      lines.push(
        terminalText(
          `SKIP: ${JSON.stringify(safeText(item.file, "fix file"))} — ${safeText(item.reason, "skip reason")}`,
          "reason",
          color,
        ),
      );
    } else {
      lines.push(
        `${terminalText(item.checkId, "primary", color)}${terminalText(`: ${JSON.stringify(safeText(item.file, "fix file"))} (${item.scope}, ${fixLabel(fixesFor(item))})`, "secondary", color)}`,
      );
    }
  }
  if (plan.items.length > items.length) {
    lines.push(
      `Showing ${items.reduce((total, item) => total + fixesFor(item), 0)} of ${plan.summary.fixes} planned fixes.`,
    );
  }
  if (reportPath !== undefined) {
    lines.push(
      terminalText(
        `Complete plan: ${opaqueTemporaryReportPath(reportPath)}`,
        "secondary",
        color,
      ),
    );
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

function styleFixResultLine(line: string, color: boolean): string {
  if (!color || line.length === 0) return line;
  if (
    line.startsWith("Zedbee managed fixes") ||
    line.startsWith("Zedbee managed fix")
  ) {
    return terminalText(line, "primary", true);
  }
  if (/^(?:Remediation|Next step): /u.test(line)) {
    return terminalText(line, "reason", true);
  }
  const checkId = FIXABLE_CHECK_IDS.find((id) => line.startsWith(`${id}:`));
  if (checkId !== undefined) {
    const remainder = line.slice(checkId.length);
    const status = /^: (READY|INCOMPLETE|NOT APPLICABLE)(.*)$/u.exec(remainder);
    if (status !== null) {
      const statusTone =
        status[1] === "READY"
          ? "pass"
          : status[1] === "INCOMPLETE"
            ? "failure"
            : "secondary";
      return `${terminalText(checkId, "primary", true)}${terminalText(": ", "secondary", true)}${terminalText(status[1]!, statusTone, true)}${terminalText(status[2]!, status[1] === "NOT APPLICABLE" ? "reason" : "secondary", true)}`;
    }
    return `${terminalText(checkId, "primary", true)}${terminalText(remainder, "secondary", true)}`;
  }
  return terminalText(line, "secondary", true);
}

function renderResultText(
  plan: FixPlan,
  result: FixResult,
  color = false,
): string {
  const presentation = presentFixResult(plan, result);
  const headline =
    presentation.outcome === "applied"
      ? "Zedbee managed fixes applied."
      : presentation.outcome === "already-present"
        ? "Zedbee managed fixes are already present in the working tree."
        : presentation.outcome === "partially-applied"
          ? "Zedbee managed fixes partially applied."
          : "Zedbee managed fixes failed.";
  const lines = [
    headline,
    `Applied fixes: ${result.appliedFixes}`,
    `Changed files: ${result.changedFiles.length}`,
    `Already fixed files: ${presentation.alreadyFixedFiles.length}`,
    `Unresolved files: ${presentation.unresolvedFiles.length}`,
    "",
  ];
  if (presentation.alreadyFixedFiles.length > 0) {
    lines.push(
      `${presentation.alreadyFixedFiles.length} ${presentation.alreadyFixedFiles.length === 1 ? "file already contains" : "files already contain"} the planned fixes in the working tree.`,
      "Stage the files you want to keep before running zedbee scan.",
    );
  }
  for (const check of plan.checks ?? []) {
    if (lines.at(-1) !== "") lines.push("");
    if (check.status === "completed") {
      lines.push(
        `${check.checkId}: READY — ${check.fixes} ${check.fixes === 1 ? "fix" : "fixes"} found in plan`,
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
  return `${lines.map((line) => styleFixResultLine(line, color)).join("\n")}\n`;
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
          renderPlanText(
            prepared.publicPlan,
            maintenance.reportPath,
            terminalColorEnabled(options.color, io.stdoutIsTTY, io.env),
          ),
        );
      }
    };

    if (prepared.publicPlan.exitCode === 2) {
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
  } catch {
    if (options.signal?.aborted === true) {
      io.writeStderr("Zedbee fix was interrupted.\n");
    } else {
      io.writeStderr("Zedbee could not complete the managed fix.\n");
    }
    return 2;
  }
}
