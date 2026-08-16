import type {
  Attribution,
  CheckError,
  CheckResult,
  Finding,
  SourceLocation,
} from "../core/types.js";
import { displayLabel, displayProse } from "../core/display-text.js";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";

const ATTRIBUTION_KINDS = new Set<Attribution["kind"]>([
  "range-overlap",
  "syntax-ownership",
  "transformation-diff",
  "baseline-comparison",
  "metric-delta",
  "none",
]);

function sanitizeStatus(value: unknown): CheckResult["status"] {
  if (value !== "completed" && value !== "skipped" && value !== "incomplete") {
    throw new TypeError("Adapter returned an invalid check status");
  }
  return value;
}

function sanitizeSeverity(value: unknown): Finding["severity"] {
  if (value !== "info" && value !== "warning" && value !== "error") {
    throw new TypeError("Adapter returned an invalid finding severity");
  }
  return value;
}

function sanitizeAttributionKind(value: unknown): Attribution["kind"] {
  if (!ATTRIBUTION_KINDS.has(value as Attribution["kind"])) {
    throw new TypeError("Adapter returned an invalid attribution kind");
  }
  return value as Attribution["kind"];
}

// These exhaustive registries deliberately make a public result-contract change
// fail typechecking until this trusted-boundary copier is updated as well.
export const PUBLIC_CHECK_RESULT_FIELDS = {
  checkId: true,
  target: true,
  status: true,
  durationMs: true,
  findings: true,
  error: true,
  skipReason: true,
} as const satisfies Readonly<Record<keyof CheckResult, true>>;

export const PUBLIC_FINDING_FIELDS = {
  id: true,
  check: true,
  rule: true,
  severity: true,
  message: true,
  location: true,
  remediation: true,
  attribution: true,
} as const satisfies Readonly<Record<keyof Finding, true>>;

export const PUBLIC_LOCATION_FIELDS = {
  file: true,
  startLine: true,
  startColumn: true,
  endLine: true,
  endColumn: true,
} as const satisfies Readonly<Record<keyof SourceLocation, true>>;

export const PUBLIC_ATTRIBUTION_FIELDS = {
  kind: true,
  staged: true,
  evidence: true,
} as const satisfies Readonly<Record<keyof Attribution, true>>;

export const PUBLIC_CHECK_ERROR_FIELDS = {
  code: true,
  message: true,
} as const satisfies Readonly<Record<keyof CheckError, true>>;

interface CheckResultOverrides {
  readonly checkId?: string;
  readonly target?: string;
  readonly durationMs?: number;
}

function sanitizeLocation(location: SourceLocation): SourceLocation {
  return {
    file: normalizeRepositoryRelativePath(location.file),
    ...(location.startLine === undefined
      ? {}
      : { startLine: location.startLine }),
    ...(location.startColumn === undefined
      ? {}
      : { startColumn: location.startColumn }),
    ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
    ...(location.endColumn === undefined
      ? {}
      : { endColumn: location.endColumn }),
  };
}

function sanitizeAttribution(attribution: Attribution): Attribution {
  const staged = attribution.staged;
  if (typeof staged !== "boolean") {
    throw new TypeError("Adapter returned an invalid attribution staged flag");
  }
  return {
    kind: sanitizeAttributionKind(attribution.kind),
    staged,
    evidence: Array.from(attribution.evidence, (evidence) =>
      displayProse(evidence, "attribution evidence"),
    ),
  };
}

function sanitizeFinding(finding: Finding): Finding {
  return {
    id: displayLabel(finding.id, "finding id"),
    check: displayLabel(finding.check, "check label"),
    rule: displayLabel(finding.rule, "rule label"),
    severity: sanitizeSeverity(finding.severity),
    message: displayProse(finding.message, "finding message", {
      allowEmpty: true,
    }),
    ...(finding.location === undefined
      ? {}
      : { location: sanitizeLocation(finding.location) }),
    ...(finding.remediation === undefined
      ? {}
      : {
          remediation: displayProse(finding.remediation, "remediation", {
            allowEmpty: true,
          }),
        }),
    attribution: sanitizeAttribution(finding.attribution),
  };
}

function sanitizeError(error: CheckError): CheckError {
  return {
    code: displayLabel(error.code, "error code"),
    message: displayProse(error.message, "error message", {
      allowEmpty: true,
    }),
  };
}

export function sanitizeCheckResult(
  result: CheckResult,
  overrides: CheckResultOverrides = {},
): CheckResult {
  const targetValue = overrides.target ?? result.target;
  const target =
    targetValue === undefined
      ? undefined
      : displayLabel(targetValue, "result target");
  const durationMs = overrides.durationMs ?? result.durationMs;
  return {
    checkId: displayLabel(
      overrides.checkId ?? result.checkId,
      "result check id",
    ),
    ...(target === undefined ? {} : { target }),
    status: sanitizeStatus(result.status),
    durationMs,
    findings: Array.from(result.findings, sanitizeFinding),
    ...(result.error === undefined
      ? {}
      : { error: sanitizeError(result.error) }),
    ...(result.skipReason === undefined
      ? {}
      : {
          skipReason: displayProse(result.skipReason, "skip reason", {
            allowEmpty: true,
          }),
        }),
  };
}

/** Validates all externally sourced display strings before a renderer uses them. */
export function validateReportDisplayStrings(report: {
  readonly checks: readonly CheckResult[];
  readonly summary: { readonly findings: readonly Finding[] };
}): void {
  for (const check of report.checks) sanitizeCheckResult(check);
  sanitizeCheckResult({
    checkId: "summary",
    status: "completed",
    durationMs: 0,
    findings: report.summary.findings,
  });
}
