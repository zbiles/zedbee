import type {
  Attribution,
  CheckError,
  CheckResult,
  Finding,
  SourceExcerpt,
  SourceLocation,
} from "../core/types.js";
import { displayLabel, displayProse } from "../core/display-text.js";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import type { ValidatedSnapshotPath } from "../git/snapshot-path.js";
import { validateReportableSnapshotPath } from "../git/snapshot-path.js";

const ATTRIBUTION_KINDS = new Set<Attribution["kind"]>([
  "range-overlap",
  "syntax-ownership",
  "transformation-diff",
  "baseline-comparison",
  "metric-delta",
  "none",
]);

export const SOURCE_EXCERPT_MAX_CODE_POINTS = 500;

const UNSAFE_CODE_LINE_CHARACTER = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

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
  sourceExcerpt: true,
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

export const PUBLIC_SOURCE_EXCERPT_FIELDS = {
  line: true,
  text: true,
  redacted: true,
  truncated: true,
} as const satisfies Readonly<Record<keyof SourceExcerpt, true>>;

export const PUBLIC_CHECK_ERROR_FIELDS = {
  code: true,
  message: true,
  path: true,
  temporaryPath: true,
  remediation: true,
} as const satisfies Readonly<Record<keyof CheckError, true>>;

interface CheckResultOverrides {
  readonly checkId?: string;
  readonly target?: string;
  readonly durationMs?: number;
  readonly temporaryPath?: ValidatedSnapshotPath;
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

function sanitizeSourceExcerpt(
  excerpt: SourceExcerpt,
  location: SourceLocation | undefined,
): SourceExcerpt {
  const line = excerpt.line;
  if (
    !Number.isSafeInteger(line) ||
    line < 1 ||
    location?.startLine === undefined ||
    line !== location.startLine
  ) {
    throw new TypeError(
      "Expected source excerpt line to match the finding start line",
    );
  }

  const redacted = excerpt.redacted;
  const truncated = excerpt.truncated;
  if (typeof redacted !== "boolean" || typeof truncated !== "boolean") {
    throw new TypeError("Expected valid source excerpt flags");
  }

  const text = excerpt.text;
  if (redacted) {
    if (text !== undefined) {
      throw new TypeError("Expected a redacted source excerpt without text");
    }
    return { line, redacted, truncated };
  }
  if (
    typeof text !== "string" ||
    Array.from(text).length > SOURCE_EXCERPT_MAX_CODE_POINTS
  ) {
    throw new TypeError("Expected bounded source excerpt text");
  }
  return {
    line,
    text: text.replaceAll(UNSAFE_CODE_LINE_CHARACTER, "�"),
    redacted,
    truncated,
  };
}

function sanitizeFinding(finding: Finding): Finding {
  const location =
    finding.location === undefined
      ? undefined
      : sanitizeLocation(finding.location);
  return {
    id: displayLabel(finding.id, "finding id"),
    check: displayLabel(finding.check, "check label"),
    rule: displayLabel(finding.rule, "rule label"),
    severity: sanitizeSeverity(finding.severity),
    message: displayProse(finding.message, "finding message", {
      allowEmpty: true,
    }),
    ...(location === undefined ? {} : { location }),
    ...(finding.remediation === undefined
      ? {}
      : {
          remediation: displayProse(finding.remediation, "remediation", {
            allowEmpty: true,
          }),
        }),
    ...(finding.sourceExcerpt === undefined
      ? {}
      : {
          sourceExcerpt: sanitizeSourceExcerpt(finding.sourceExcerpt, location),
        }),
    attribution: sanitizeAttribution(finding.attribution),
  };
}

function sanitizeError(
  error: CheckError,
  temporaryPath: ValidatedSnapshotPath | undefined,
): CheckError {
  if (
    error.temporaryPath !== undefined &&
    (temporaryPath === undefined || error.temporaryPath !== temporaryPath)
  ) {
    throw new TypeError("Adapter returned an untrusted temporary path");
  }
  return {
    code: displayLabel(error.code, "error code"),
    message: displayProse(error.message, "error message", {
      allowEmpty: true,
    }),
    ...(error.path === undefined
      ? {}
      : { path: normalizeRepositoryRelativePath(error.path) }),
    ...(temporaryPath === undefined ? {} : { temporaryPath }),
    ...(error.remediation === undefined
      ? {}
      : {
          remediation: displayProse(error.remediation, "error remediation", {
            allowEmpty: true,
          }),
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
      : { error: sanitizeError(result.error, overrides.temporaryPath) }),
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
  for (const check of report.checks) {
    const temporaryPath = check.error?.temporaryPath;
    sanitizeCheckResult(
      check,
      temporaryPath === undefined
        ? {}
        : {
            temporaryPath: validateReportableSnapshotPath(temporaryPath),
          },
    );
  }
  sanitizeCheckResult({
    checkId: "summary",
    status: "completed",
    durationMs: 0,
    findings: report.summary.findings,
  });
}
