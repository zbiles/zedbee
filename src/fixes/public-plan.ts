import { freezeResult } from "../core/freeze-result.js";
import { compareCodeUnits } from "../core/compare.js";
import type { CheckExecutionResult } from "../checks/adapter.js";
import { sanitizeAnalyzerDiagnostic } from "../checks/diagnostics.js";
import type { PolicyDecision } from "../policy/evaluate.js";
import type {
  FixPlan,
  FixPlanCheck,
  FixPlanFile,
  FixPlanItem,
  FixPlanSummary,
  FixableCheckId,
  WorkingFilePreview,
} from "./types.js";

export function publicPlan(
  selected: readonly FixableCheckId[],
  items: readonly FixPlanItem[],
  workingFiles: ReadonlyMap<string, WorkingFilePreview>,
  checks: readonly FixPlanCheck[],
  decision?: PolicyDecision,
): FixPlan {
  const fixesFor = (item: FixPlanItem): number =>
    item.fixes ?? (item.scope === "finding" ? item.findingIds.length : 1);
  const applicableFindingIds = new Set(
    items
      .filter((item) => item.status !== "skipped")
      .flatMap((item) => item.findingIds),
  );
  const hasUnresolvedBlockingFinding =
    decision?.summary.findings.some(
      (finding) =>
        finding.severity === "error" && !applicableFindingIds.has(finding.id),
    ) ?? false;
  const itemsByFile = new Map<string, FixPlanItem[]>();
  for (const item of items) {
    const group = itemsByFile.get(item.file);
    if (group === undefined) itemsByFile.set(item.file, [item]);
    else group.push(item);
  }
  const files = [...workingFiles.values()]
    .map((preview): FixPlanFile => {
      const fileItems = itemsByFile.get(preview.path) ?? [];
      const fixes = fileItems.reduce(
        (total, item) => total + fixesFor(item),
        0,
      );
      const skippedFixes = fileItems
        .filter((item) => item.status === "skipped")
        .reduce((total, item) => total + fixesFor(item), 0);
      const applicableFixes = fixes - skippedFixes;
      const reasons = [
        ...new Set(
          fileItems.flatMap((item) =>
            item.status === "skipped" && item.reason !== undefined
              ? [item.reason]
              : [],
          ),
        ),
      ];
      return Object.freeze({
        path: preview.path,
        fixes,
        applicableFixes,
        skippedFixes,
        status:
          skippedFixes === 0
            ? ("applicable" as const)
            : applicableFixes === 0
              ? ("skipped" as const)
              : ("partial" as const),
        reasons: Object.freeze(reasons),
        hasUnstagedChanges: preview.hasUnstagedChanges,
      });
    })
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const summary: FixPlanSummary = Object.freeze({
    fixes: items.reduce((total, item) => total + fixesFor(item), 0),
    files: files.length,
    blocking: items.reduce((total, item) => total + item.blocking, 0),
    warnings: items.reduce((total, item) => total + item.warnings, 0),
    skipped: items
      .filter((item) => item.status === "skipped")
      .reduce((total, item) => total + fixesFor(item), 0),
  });
  return freezeResult({
    schemaVersion: 1 as const,
    target: "index" as const,
    selectedChecks: selected,
    exitCode:
      checks.some((check) => check.status === "incomplete") ||
      hasUnresolvedBlockingFinding
        ? (1 as const)
        : (0 as const),
    checks,
    summary,
    files,
    items,
  });
}

export function planChecks(
  selected: readonly FixableCheckId[],
  executions: readonly CheckExecutionResult[],
  items: readonly FixPlanItem[],
): readonly FixPlanCheck[] {
  const fixesFor = (item: FixPlanItem): number =>
    item.fixes ?? (item.scope === "finding" ? item.findingIds.length : 1);
  return Object.freeze(
    selected.map((checkId): FixPlanCheck => {
      const checkExecutions = executions.filter(
        (execution) => execution.result.checkId === checkId,
      );
      const incomplete = checkExecutions.filter(
        (execution) => execution.result.status === "incomplete",
      );
      const completed = checkExecutions.some(
        (execution) => execution.result.status === "completed",
      );
      const fixes = items
        .filter((item) => item.checkId === checkId && item.status !== "skipped")
        .reduce((total, item) => total + fixesFor(item), 0);
      const issues = incomplete.flatMap((execution) => {
        const error = execution.result.error;
        return error === undefined
          ? [
              {
                code: "CHECK_INCOMPLETE",
                message: "The check could not finish.",
              },
            ]
          : [
              {
                code: error.code,
                ...(error.diagnostic === undefined
                  ? {}
                  : {
                      diagnostic: sanitizeAnalyzerDiagnostic(error.diagnostic),
                    }),
                message: error.message,
                ...(error.path === undefined ? {} : { path: error.path }),
                ...(error.remediation === undefined
                  ? {}
                  : { remediation: error.remediation }),
              },
            ];
      });
      if (incomplete.length > 0) {
        return Object.freeze({
          checkId,
          status: "incomplete" as const,
          fixes,
          issues: Object.freeze(issues),
        });
      }
      if (completed || fixes > 0) {
        return Object.freeze({
          checkId,
          status: "completed" as const,
          fixes,
          issues: Object.freeze([]),
        });
      }
      const reasons = checkExecutions.flatMap((execution) =>
        execution.result.skipReason === undefined
          ? []
          : [execution.result.skipReason],
      );
      return Object.freeze({
        checkId,
        status: "not-applicable" as const,
        fixes: 0,
        issues: Object.freeze([]),
        reason: reasons[0] ?? "No applicable target was found.",
      });
    }),
  );
}

/** Serializes only the public, source-free plan projection. */
export function renderFixPlanJson(plan: FixPlan): string {
  return `${JSON.stringify(
    {
      schemaVersion: plan.schemaVersion,
      target: plan.target,
      selectedChecks: [...plan.selectedChecks],
      exitCode: plan.exitCode,
      ...(plan.checks === undefined
        ? {}
        : {
            checks: plan.checks.map((check) => ({
              checkId: check.checkId,
              status: check.status,
              fixes: check.fixes,
              issues: check.issues.map((issue) => ({
                code: issue.code,
                ...(issue.diagnostic === undefined
                  ? {}
                  : {
                      diagnostic: sanitizeAnalyzerDiagnostic(issue.diagnostic),
                    }),
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
        fixes: plan.summary.fixes,
        files: plan.summary.files,
        blocking: plan.summary.blocking,
        warnings: plan.summary.warnings,
        skipped: plan.summary.skipped,
      },
      files: plan.files.map((file) => ({
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
      items: plan.items.map((item) => ({
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
    },
    null,
    2,
  )}\n`;
}
