import type { FixPlan, FixResult } from "./types.js";

export type FixResultOutcome =
  "applied" | "partially-applied" | "already-present" | "failed";

export interface FixResultPresentation {
  readonly outcome: FixResultOutcome;
  readonly alreadyFixedFiles: readonly string[];
  readonly unresolvedFiles: readonly string[];
}

export function presentFixResult(
  plan: FixPlan,
  result: FixResult,
): FixResultPresentation {
  const issueFiles = new Set(result.issues.map((issue) => issue.file));
  const alreadyFixedFiles = result.unchangedFiles.filter(
    (file) => !issueFiles.has(file),
  );
  const unresolvedFiles = result.unchangedFiles.filter((file) =>
    issueFiles.has(file),
  );
  const outcome: FixResultOutcome =
    result.exitCode !== 0
      ? result.appliedFixes > 0 || alreadyFixedFiles.length > 0
        ? "partially-applied"
        : "failed"
      : result.appliedFixes === 0 && alreadyFixedFiles.length > 0
        ? "already-present"
        : plan.exitCode !== 0
          ? "partially-applied"
          : "applied";
  return Object.freeze({
    outcome,
    alreadyFixedFiles: Object.freeze(alreadyFixedFiles),
    unresolvedFiles: Object.freeze(unresolvedFiles),
  });
}
