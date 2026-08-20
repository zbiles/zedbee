import { validateReportDisplayStrings } from "../checks/sanitize-result.js";
import { compareCodeUnits } from "../core/compare.js";
import { ZEDBEE_VERSION } from "../core/package-version.js";
import { compareFindings } from "../core/summarize.js";
import type {
  CheckError,
  CheckResult,
  Finding,
  SourceLocation,
} from "../core/types.js";
import { checkLabel } from "../reporting/check-label.js";
import type { NetworkDisclosure, ScanReport } from "../scan/report.js";

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const INFORMATION_URI = "https://github.com/zbiles/Zedbee";

interface SarifRule {
  readonly id: string;
  readonly shortDescription: { readonly text: string };
  readonly properties: {
    readonly checkId: string;
    readonly ruleId: string;
  };
}

interface IncompleteCheckWithError extends CheckResult {
  readonly status: "incomplete";
  readonly error: CheckError;
}

interface SerializedDisclosure {
  readonly checkId: string;
  readonly target: string;
  readonly services: readonly string[];
  readonly metadata: readonly string[];
}

function ruleId(finding: Pick<Finding, "check" | "rule">): string {
  return `${encodeURIComponent(finding.check)}/${encodeURIComponent(finding.rule)}`;
}

function createRules(findings: readonly Finding[]): SarifRule[] {
  const findingsByRule = new Map<string, Finding>();
  for (const finding of findings) {
    const id = ruleId(finding);
    if (!findingsByRule.has(id)) findingsByRule.set(id, finding);
  }

  return [...findingsByRule]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([id, finding]) => ({
      id,
      shortDescription: {
        text: `${checkLabel(finding.check)}: ${finding.rule}`,
      },
      properties: {
        checkId: finding.check,
        ruleId: finding.rule,
      },
    }));
}

function artifactUri(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function positiveSafeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function createRegion(
  location: SourceLocation,
  finding: Finding,
): Record<string, unknown> | undefined {
  const startLine = positiveSafeInteger(location.startLine);
  if (startLine === undefined) return undefined;

  const startColumn = positiveSafeInteger(location.startColumn);
  const candidateEndLine = positiveSafeInteger(location.endLine);
  const endLine =
    candidateEndLine !== undefined && candidateEndLine >= startLine
      ? candidateEndLine
      : undefined;
  const rejectedEndLine =
    location.endLine !== undefined && endLine === undefined;
  const candidateEndColumn = positiveSafeInteger(location.endColumn);
  const sameEffectiveLine = endLine === undefined || endLine === startLine;
  const endColumn =
    candidateEndColumn !== undefined &&
    !rejectedEndLine &&
    (!sameEffectiveLine ||
      startColumn === undefined ||
      candidateEndColumn >= startColumn)
      ? candidateEndColumn
      : undefined;
  const excerpt = finding.sourceExcerpt;
  const snippet =
    excerpt !== undefined && !excerpt.redacted && excerpt.text !== undefined
      ? { text: excerpt.text }
      : undefined;

  return {
    startLine,
    ...(startColumn === undefined ? {} : { startColumn }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(endColumn === undefined ? {} : { endColumn }),
    ...(snippet === undefined ? {} : { snippet }),
  };
}

function createLocation(
  finding: Finding,
): Record<string, unknown>[] | undefined {
  const location = finding.location;
  if (location === undefined) return undefined;
  const region = createRegion(location, finding);
  return [
    {
      physicalLocation: {
        artifactLocation: { uri: artifactUri(location.file) },
        ...(region === undefined ? {} : { region }),
      },
    },
  ];
}

function createResult(
  finding: Finding,
  ruleIndexes: ReadonlyMap<string, number>,
): Record<string, unknown> {
  const id = ruleId(finding);
  const locations = createLocation(finding);
  return {
    ruleId: id,
    ruleIndex: ruleIndexes.get(id),
    level: finding.severity === "error" ? "error" : "warning",
    message: { text: finding.message },
    partialFingerprints: { "zedbee/v1": finding.id },
    ...(locations === undefined ? {} : { locations }),
    properties: {
      checkId: finding.check,
      ruleId: finding.rule,
      attributionKind: finding.attribution.kind,
      staged: finding.attribution.staged,
      evidence: [...finding.attribution.evidence].sort(compareCodeUnits),
      ...(finding.remediation === undefined
        ? {}
        : { remediation: finding.remediation }),
      ...(finding.sourceExcerpt?.redacted === false
        ? { sourceExcerptTruncated: finding.sourceExcerpt.truncated }
        : {}),
    },
  };
}

function compareIncompleteChecks(
  left: IncompleteCheckWithError,
  right: IncompleteCheckWithError,
): number {
  return (
    compareCodeUnits(left.checkId, right.checkId) ||
    compareCodeUnits(left.error.code, right.error.code) ||
    compareCodeUnits(left.error.message, right.error.message)
  );
}

function isIncompleteCheckWithError(
  check: CheckResult,
): check is IncompleteCheckWithError {
  return check.status === "incomplete" && check.error !== undefined;
}

function createNotification(
  check: IncompleteCheckWithError,
): Record<string, unknown> {
  const error = check.error;
  return {
    descriptor: { id: error.code },
    level: check.incompleteDisposition === "warn" ? "warning" : "error",
    message: { text: error.message },
    properties: {
      checkId: check.checkId,
      errorCode: error.code,
      ...(check.incompleteDisposition === undefined
        ? {}
        : { disposition: check.incompleteDisposition }),
      ...(check.target === undefined ? {} : { target: check.target }),
      durationMs: check.durationMs,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.temporaryPath === undefined
        ? {}
        : { temporaryPath: error.temporaryPath }),
      ...(error.remediation === undefined
        ? {}
        : { remediation: error.remediation }),
    },
  };
}

function serializeDisclosure(
  disclosure: NetworkDisclosure,
): SerializedDisclosure {
  return {
    checkId: disclosure.checkId,
    target: disclosure.target,
    services: [...disclosure.services].sort(compareCodeUnits),
    metadata: [...disclosure.metadata].sort(compareCodeUnits),
  };
}

function createInvocation(
  report: ScanReport,
  checks: readonly CheckResult[],
): Record<string, unknown> {
  const notifications = checks
    .filter(isIncompleteCheckWithError)
    .sort(compareIncompleteChecks)
    .map(createNotification);
  const disclosures = report.networkDisclosures
    .map(serializeDisclosure)
    .sort(
      (left, right) =>
        compareCodeUnits(left.checkId, right.checkId) ||
        compareCodeUnits(left.target, right.target),
    );

  return {
    executionSuccessful: report.outcome !== "incomplete",
    startTimeUtc: report.startedAt,
    toolExecutionNotifications: notifications,
    properties: {
      schemaVersion: report.schemaVersion,
      outcome: report.outcome,
      exitCode: report.exitCode,
      baseline: report.baseline,
      target: report.target,
      stagedFileCount: report.stagedFileCount,
      startedAt: report.startedAt,
      durationMs: report.durationMs,
      networkDisclosures: disclosures,
    },
  };
}

export function renderSarif(report: ScanReport): string {
  const sanitized = validateReportDisplayStrings(report);
  const findings = [...sanitized.summaryFindings].sort(compareFindings);
  const rules = createRules(findings);
  const ruleIndexes = new Map(rules.map((rule, index) => [rule.id, index]));
  const document = {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Zedbee",
            semanticVersion: ZEDBEE_VERSION,
            informationUri: INFORMATION_URI,
            rules,
          },
        },
        results: findings.map((finding) => createResult(finding, ruleIndexes)),
        invocations: [createInvocation(report, sanitized.checks)],
      },
    ],
  };

  return JSON.stringify(document, null, 2);
}
