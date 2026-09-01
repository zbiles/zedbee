import { compareFindings } from "../core/summarize.js";
import type { CheckResult, Finding } from "../core/types.js";
import type { ScanReport } from "../scan/report.js";
import { validateReportDisplayStrings } from "../checks/sanitize-result.js";
import { compareCodeUnits } from "../core/compare.js";
import { sanitizeScanSourceIdentity } from "../scan/source-mode.js";

function serializeFinding(finding: Finding): Record<string, unknown> {
  const sourceExcerpt =
    finding.sourceExcerpt === undefined
      ? undefined
      : {
          line: finding.sourceExcerpt.line,
          ...(finding.sourceExcerpt.text === undefined
            ? {}
            : { text: finding.sourceExcerpt.text }),
          redacted: finding.sourceExcerpt.redacted,
          truncated: finding.sourceExcerpt.truncated,
        };
  return {
    id: finding.id,
    check: finding.check,
    rule: finding.rule,
    severity: finding.severity,
    message: finding.message,
    ...(finding.location === undefined ? {} : { location: finding.location }),
    ...(finding.remediation === undefined
      ? {}
      : { remediation: finding.remediation }),
    ...(finding.automaticFix === undefined
      ? {}
      : {
          automaticFix: {
            available: true,
            command: [...finding.automaticFix.command],
            scope: finding.automaticFix.scope,
            writes: finding.automaticFix.writes,
            stagesChanges: false,
          },
        }),
    ...(sourceExcerpt === undefined ? {} : { sourceExcerpt }),
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
          ...(check.error.paths === undefined
            ? {}
            : { paths: [...check.error.paths] }),
          ...(check.error.snapshot === undefined
            ? {}
            : { snapshot: check.error.snapshot }),
          ...(check.error.projectPaths === undefined
            ? {}
            : { projectPaths: [...check.error.projectPaths] }),
          ...(check.error.temporaryPath === undefined
            ? {}
            : { temporaryPath: check.error.temporaryPath }),
          ...(check.error.remediation === undefined
            ? {}
            : { remediation: check.error.remediation }),
        };
  return {
    checkId: check.checkId,
    ...(check.target === undefined ? {} : { target: check.target }),
    status: check.status,
    durationMs: check.durationMs,
    findings: [...check.findings].sort(compareFindings).map(serializeFinding),
    ...(error === undefined ? {} : { error }),
    ...(check.skipReason === undefined ? {} : { skipReason: check.skipReason }),
    ...(check.incompleteDisposition === undefined
      ? {}
      : { incompleteDisposition: check.incompleteDisposition }),
  };
}

export function renderJson(report: ScanReport): string {
  const sanitized = validateReportDisplayStrings(report);
  const source = sanitizeScanSourceIdentity(report);
  const payload = {
    schemaVersion: report.schemaVersion,
    outcome: report.outcome,
    exitCode: report.exitCode,
    repositoryRoot: ".",
    mode: source.mode,
    baseline: source.baseline,
    target: source.target,
    ...(source.requestedBase === undefined
      ? {}
      : { requestedBase: source.requestedBase }),
    changedFileCount: report.changedFileCount,
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
    checks: [...sanitized.checks]
      .sort(
        (left, right) =>
          compareCodeUnits(left.checkId, right.checkId) ||
          compareCodeUnits(left.target ?? "", right.target ?? ""),
      )
      .map(serializeCheck),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
