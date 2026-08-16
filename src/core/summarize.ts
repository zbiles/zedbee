import type { CheckResult, Finding, RunSummary } from "./types.js";
import { compareCodeUnits } from "./compare.js";

function compareOptionalNumbers(
  left: number | undefined,
  right: number | undefined,
): number {
  return (left ?? 0) - (right ?? 0);
}

export function compareFindings(left: Finding, right: Finding): number {
  return (
    compareCodeUnits(left.check, right.check) ||
    compareCodeUnits(left.location?.file ?? "", right.location?.file ?? "") ||
    compareOptionalNumbers(
      left.location?.startLine,
      right.location?.startLine,
    ) ||
    compareOptionalNumbers(
      left.location?.startColumn,
      right.location?.startColumn,
    ) ||
    compareOptionalNumbers(left.location?.endLine, right.location?.endLine) ||
    compareOptionalNumbers(
      left.location?.endColumn,
      right.location?.endColumn,
    ) ||
    compareCodeUnits(left.rule, right.rule) ||
    compareCodeUnits(left.id, right.id)
  );
}

export function summarizeChecks(results: readonly CheckResult[]): RunSummary {
  const findings = results
    .flatMap((result) => result.findings)
    .sort(compareFindings);

  return {
    passed: results.filter(
      (result) => result.status === "completed" && result.findings.length === 0,
    ).length,
    warnings: findings.filter(
      (finding) =>
        finding.severity === "warning" || finding.severity === "info",
    ).length,
    failed: findings.filter((finding) => finding.severity === "error").length,
    incomplete: results.filter((result) => result.status === "incomplete")
      .length,
    findings,
  };
}
