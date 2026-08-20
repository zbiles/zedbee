import type { ResolvedCheckPolicy, ResolvedConfig } from "../config/schema.js";
import { summarizeChecks } from "../core/summarize.js";
import type { CheckResult, Finding, RunSummary } from "../core/types.js";
import type { CheckExecutionResult } from "../checks/adapter.js";
import { sanitizeCheckResult } from "../checks/sanitize-result.js";

export interface PolicyDecision {
  exitCode: 0 | 1 | 2;
  outcome: "pass" | "blocked" | "incomplete";
  results: readonly CheckResult[];
  summary: RunSummary;
}

function applySeverity(finding: Finding, policy: ResolvedCheckPolicy): Finding {
  return {
    ...finding,
    severity: policy.severity === "warn" ? "warning" : "error",
  };
}

export function displayResultForPolicy(
  result: CheckResult,
  policy: Readonly<ResolvedCheckPolicy> | null,
): CheckResult | undefined {
  const sanitizedResult = sanitizeCheckResult(result);
  if (policy === null) return sanitizedResult;
  if (policy.severity === "off") return undefined;
  if (sanitizedResult.status !== "completed") return sanitizedResult;
  return sanitizeCheckResult({
    ...sanitizedResult,
    findings: sanitizedResult.findings
      .filter((finding) => finding.attribution.staged)
      .map((finding) => applySeverity(finding, policy)),
  });
}

export function evaluatePolicy(
  executions: readonly CheckExecutionResult[],
  config: ResolvedConfig,
): PolicyDecision {
  const evaluated = executions.flatMap(({ result, policy }): CheckResult[] => {
    const displayed = displayResultForPolicy(result, policy);
    if (displayed === undefined) return [];
    if (displayed.status !== "incomplete") return [displayed];
    return [
      {
        ...displayed,
        incompleteDisposition:
          displayed.incompleteDisposition ??
          (config.failOnIncomplete ? "block" : "warn"),
      },
    ];
  });
  const summary = summarizeChecks(evaluated);

  const hasBlockingIncomplete = evaluated.some(
    (result) =>
      result.status === "incomplete" &&
      result.incompleteDisposition === "block",
  );

  if (hasBlockingIncomplete) {
    return { exitCode: 2, outcome: "incomplete", results: evaluated, summary };
  }
  if (summary.failed > 0) {
    return { exitCode: 1, outcome: "blocked", results: evaluated, summary };
  }
  return { exitCode: 0, outcome: "pass", results: evaluated, summary };
}
