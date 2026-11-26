import { localScanDiagnostics } from "../diagnostics/local-scan-diagnostics.js";
import { sanitizeComparisonContext } from "../checks/comparison-context.js";
import { sanitizeEslintAnalysis } from "../checks/sanitize-result.js";
import { sanitizeFormattingCoverage } from "../checks/sanitize-result.js";
import { compareFindings } from "../core/summarize.js";
import type { CheckResult, Finding } from "../core/types.js";
import type { ScanReport } from "../scan/report.js";
import { validateReportDisplayStrings } from "../checks/sanitize-result.js";
import { compareCodeUnits } from "../core/compare.js";
import { sanitizeScanSourceIdentity } from "../scan/source-mode.js";
import { fixCommandArguments } from "../reporting/fix-command.js";
import { hookUpdateNotice } from "../reporting/hook-update-notice.js";
import { checkErrorDetailFields } from "./check-error-fields.js";
import { sourceIdentityFields } from "./source-identity-fields.js";

function serializeFinding(
  finding: Finding,
  installedCliCommand: readonly string[] | undefined,
  includeSourceExcerpts: boolean,
): Record<string, unknown> {
  const sourceExcerpt =
    finding.sourceExcerpt === undefined ||
    (!includeSourceExcerpts && !finding.sourceExcerpt.redacted)
      ? undefined
      : {
          line: finding.sourceExcerpt.line,
          ...(!includeSourceExcerpts || finding.sourceExcerpt.text === undefined
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
    ...(finding.messageRedaction === undefined
      ? {}
      : {
          messageRedaction: {
            redacted: finding.messageRedaction.redacted,
            reasons: [...finding.messageRedaction.reasons],
          },
        }),
    ...(finding.location === undefined ? {} : { location: finding.location }),
    ...(finding.remediation === undefined
      ? {}
      : { remediation: finding.remediation }),
    ...(finding.automaticFix === undefined
      ? {}
      : {
          automaticFix: {
            available: true,
            command: [
              ...fixCommandArguments(finding.automaticFix, installedCliCommand),
            ],
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

function serializeCheck(
  check: CheckResult,
  installedCliCommand: readonly string[] | undefined,
  includeSourceExcerpts: boolean,
): Record<string, unknown> {
  const error =
    check.error === undefined
      ? undefined
      : {
          code: check.error.code,
          ...(check.error.diagnostic === undefined
            ? {}
            : { diagnostic: check.error.diagnostic }),
          message: check.error.message,
          ...checkErrorDetailFields(check.error),
        };
  return {
    ...(check.eslintAnalysis === undefined
      ? {}
      : { eslintAnalysis: sanitizeEslintAnalysis(check.eslintAnalysis) }),
    ...(check.comparisonContext === undefined
      ? {}
      : {
          comparisonContext: sanitizeComparisonContext(check.comparisonContext),
        }),
    checkId: check.checkId,
    ...(check.target === undefined ? {} : { target: check.target }),
    status: check.status,
    durationMs: check.durationMs,
    findings: [...check.findings]
      .sort(compareFindings)
      .map((finding) =>
        serializeFinding(finding, installedCliCommand, includeSourceExcerpts),
      ),
    ...(error === undefined ? {} : { error }),
    ...(check.skipReason === undefined ? {} : { skipReason: check.skipReason }),
    ...(check.incompleteDisposition === undefined
      ? {}
      : { incompleteDisposition: check.incompleteDisposition }),
    ...(check.formattingCoverage === undefined
      ? {}
      : {
          formattingCoverage: sanitizeFormattingCoverage(
            check.formattingCoverage,
          ),
        }),
    ...(check.formattingProvenance === undefined ||
    check.formattingProvenance.length === 0
      ? {}
      : {
          formattingProvenance: [...check.formattingProvenance].map(
            (entry) => ({
              engine: entry.engine,
              version: entry.version,
              projectRoot: entry.projectRoot,
              configFiles: [...entry.configFiles],
            }),
          ),
        }),
  };
}

export function renderJson(
  report: ScanReport,
  { includeSourceExcerpts = true }: { includeSourceExcerpts?: boolean } = {},
): string {
  const sanitized = validateReportDisplayStrings(report);
  const source = sanitizeScanSourceIdentity(report);
  const diagnostics = localScanDiagnostics(report.diagnostics);
  const hookUpdate = hookUpdateNotice(report);
  const payload = {
    schemaVersion: report.schemaVersion,
    outcome: report.outcome,
    exitCode: report.exitCode,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(hookUpdate === undefined ? {} : { hookUpdate }),
    repositoryRoot: ".",
    ...sourceIdentityFields(source),
    changedFileCount: report.changedFileCount,
    ...(report.changeSummary === undefined
      ? {}
      : { changeSummary: report.changeSummary }),
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    ...(report.configuredPathExclusions.length === 0
      ? {}
      : { configuredPathExclusions: report.configuredPathExclusions }),
    ...(report.appliedPathExclusions.length === 0
      ? {}
      : { appliedPathExclusions: report.appliedPathExclusions }),
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
      .map((check) =>
        serializeCheck(
          check,
          report.installedCliCommand,
          includeSourceExcerpts,
        ),
      ),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
