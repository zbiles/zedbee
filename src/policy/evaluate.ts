import { isConfigurableRuleCheckId } from "../config/settings-registry.js";
import {
  type ResolvedCheckPolicy,
  type ResolvedConfig,
} from "../config/schema.js";
import { type CheckId, isCheckId } from "../core/check-ids.js";
import { summarizeChecks } from "../core/summarize.js";
import type { CheckResult, Finding, RunSummary } from "../core/types.js";
import type { CheckExecutionResult } from "../checks/adapter.js";
import { sanitizeCheckResult } from "../checks/sanitize-result.js";
import type { FilePolicyResolver } from "../config/file-policy.js";

export interface PolicyDecision {
  exitCode: 0 | 1 | 2;
  outcome: "pass" | "blocked" | "incomplete";
  results: readonly CheckResult[];
  summary: RunSummary;
}

function applySeverity(
  finding: Finding,
  policy: ResolvedCheckPolicy,
): Finding | undefined {
  const ruleOwned = isConfigurableRuleCheckId(finding.check);
  const configured =
    ruleOwned && "rules" in policy ? policy.rules?.[finding.rule] : undefined;
  const level = Array.isArray(configured) ? configured[0] : configured;
  if (level === "off" || level === 0) return undefined;
  if (
    finding.check === "lint" &&
    "engine" in policy &&
    policy.engine === "project"
  )
    return {
      ...finding,
      severity: policy.severity === "warn" ? "warning" : finding.severity,
    };
  return {
    ...finding,
    severity:
      policy.severity === "warn" || level === "warn" || level === 1
        ? "warning"
        : "error",
  };
}

function filePolicyFor(
  policy: Readonly<ResolvedCheckPolicy>,
  checkId: CheckId,
  policyForFile: FilePolicyResolver,
  file: string,
): Readonly<ResolvedCheckPolicy> | undefined {
  const excluded =
    (policyForFile.pathExclusionsForFile?.(checkId, file, "target").length ??
      0) > 0;
  if (excluded) return undefined;
  return checkId === "duplication"
    ? policy
    : policyForFile(checkId, file, "target");
}

function findingPolicyLookup(
  policy: Readonly<ResolvedCheckPolicy>,
  checkId: CheckId | undefined,
  policyForFile: FilePolicyResolver | undefined,
): (file: string | undefined) => Readonly<ResolvedCheckPolicy> | undefined {
  if (policyForFile === undefined || checkId === undefined) return () => policy;
  const byFile = new Map<string, Readonly<ResolvedCheckPolicy> | undefined>();
  return (file) => {
    if (file === undefined) return policy;
    if (!byFile.has(file))
      byFile.set(file, filePolicyFor(policy, checkId, policyForFile, file));
    return byFile.get(file);
  };
}

export function displayResultForPolicy(
  result: CheckResult,
  policy: Readonly<ResolvedCheckPolicy> | null,
  policyForFile?: FilePolicyResolver,
): CheckResult | undefined {
  const sanitizedResult = sanitizeCheckResult(result);
  if (policy === null) return sanitizedResult;
  if (sanitizedResult.status !== "completed") {
    return policy.severity === "off" ? undefined : sanitizedResult;
  }
  if (policy.severity === "off" && policyForFile === undefined)
    return undefined;
  const checkId = isCheckId(sanitizedResult.checkId)
    ? sanitizedResult.checkId
    : undefined;
  const policyFor = findingPolicyLookup(policy, checkId, policyForFile);
  return {
    ...sanitizedResult,
    findings: sanitizedResult.findings
      .filter((finding) => finding.attribution.staged)
      .flatMap((finding) => {
        const filePolicy = policyFor(finding.location?.file);
        if (filePolicy === undefined || filePolicy.severity === "off")
          return [];
        const applied = applySeverity(finding, filePolicy);
        return applied === undefined ? [] : [applied];
      }),
  };
}

export function evaluatePolicy(
  executions: readonly CheckExecutionResult[],
  config: ResolvedConfig,
): PolicyDecision {
  const evaluated = executions.flatMap(
    ({ result, policy, policyForFile }): CheckResult[] => {
      const displayed = displayResultForPolicy(result, policy, policyForFile);
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
    },
  );
  const summary = summarizeChecks(evaluated);

  const hasBlockingIncomplete = evaluated.some(
    (result) =>
      result.status === "incomplete" &&
      result.incompleteDisposition === "block",
  );

  return {
    ...scanOutcome(summary, hasBlockingIncomplete),
    results: evaluated,
    summary,
  };
}

export function scanOutcome(
  summary: Pick<RunSummary, "failed">,
  blockingIncomplete: boolean,
): Pick<PolicyDecision, "outcome" | "exitCode"> {
  if (blockingIncomplete) return { exitCode: 2, outcome: "incomplete" };
  if (summary.failed > 0) return { exitCode: 1, outcome: "blocked" };
  return { exitCode: 0, outcome: "pass" };
}
