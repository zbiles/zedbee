import { compareFindings } from "../core/summarize.js";
import type { CheckResult, Finding } from "../core/types.js";
import type { ScanReport } from "../scan/report.js";
import { validateReportDisplayStrings } from "../checks/sanitize-result.js";
import { compareCodeUnits } from "../core/compare.js";

function serializeFinding(finding: Finding): Record<string, unknown> {
  return {
    id: finding.id,
    check: finding.check,
    rule: finding.rule,
    severity: finding.severity,
    message: finding.message,
    location: finding.location,
    remediation: finding.remediation,
    ...(finding.sourceExcerpt === undefined
      ? {}
      : { sourceExcerpt: finding.sourceExcerpt }),
    attribution: {
      kind: finding.attribution.kind,
      staged: finding.attribution.staged,
      evidence: [...finding.attribution.evidence].sort(compareCodeUnits),
    },
  };
}

function serializeCheck(check: CheckResult): Record<string, unknown> {
  const error =
    check.error === undefined
      ? undefined
      : {
          code: check.error.code,
          message: check.error.message,
          ...(check.error.path === undefined ? {} : { path: check.error.path }),
          ...(check.error.temporaryPath === undefined
            ? {}
            : { temporaryPath: check.error.temporaryPath }),
          ...(check.error.remediation === undefined
            ? {}
            : { remediation: check.error.remediation }),
        };
  return {
    checkId: check.checkId,
    target: check.target,
    status: check.status,
    durationMs: check.durationMs,
    findings: [...check.findings].sort(compareFindings).map(serializeFinding),
    ...(error === undefined ? {} : { error }),
    skipReason: check.skipReason,
  };
}

export function renderJson(report: ScanReport): string {
  validateReportDisplayStrings(report);
  const payload = {
    schemaVersion: report.schemaVersion,
    outcome: report.outcome,
    exitCode: report.exitCode,
    repositoryRoot: ".",
    baseline: report.baseline,
    target: report.target,
    stagedFileCount: report.stagedFileCount,
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    networkDisclosures: report.networkDisclosures.map((disclosure) => ({
      checkId: disclosure.checkId,
      target: disclosure.target,
      services: [...disclosure.services],
      metadata: [...disclosure.metadata],
    })),
    summary: {
      passed: report.summary.passed,
      warnings: report.summary.warnings,
      failed: report.summary.failed,
      incomplete: report.summary.incomplete,
    },
    checks: [...report.checks]
      .sort(
        (left, right) =>
          compareCodeUnits(left.checkId, right.checkId) ||
          compareCodeUnits(left.target ?? "", right.target ?? ""),
      )
      .map(serializeCheck),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
