import { SOURCE_EXCERPT_MAX_CODE_POINTS } from "../checks/sanitize-result.js";
import { summarizeChecks } from "../core/summarize.js";
import type { CheckResult, Finding, SourceExcerpt } from "../core/types.js";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import { readContainedLines } from "../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  type SnapshotRegistry,
} from "../inspection/snapshot-registry.js";
import type { RepositoryInspection } from "../inspection/types.js";
import { sanitizeSourceLine } from "../reporting/source-line.js";
import type { ScanReport } from "./report.js";

interface SecretRange {
  readonly startLine: number;
  readonly endLine: number;
}

function normalizedPath(file: string): string | undefined {
  try {
    return normalizeRepositoryRelativePath(file);
  } catch {
    return undefined;
  }
}

function secretRangeIndex(
  checks: readonly CheckResult[],
): ReadonlyMap<string, readonly SecretRange[]> {
  const ranges = new Map<string, SecretRange[]>();
  for (const check of checks) {
    for (const finding of check.findings) {
      if (finding.check !== "secrets") continue;
      const location = finding.location;
      const startLine = location?.startLine;
      if (
        location === undefined ||
        startLine === undefined ||
        !Number.isSafeInteger(startLine) ||
        startLine < 1
      ) {
        continue;
      }
      const file = normalizedPath(location.file);
      if (file === undefined) continue;
      const endLine =
        Number.isSafeInteger(location.endLine) &&
        location.endLine !== undefined &&
        location.endLine >= startLine
          ? location.endLine
          : startLine;
      const fileRanges = ranges.get(file) ?? [];
      fileRanges.push({ startLine, endLine });
      ranges.set(file, fileRanges);
    }
  }
  return ranges;
}

function overlapsSecretLine(
  index: ReadonlyMap<string, readonly SecretRange[]>,
  file: string,
  line: number,
): boolean {
  const normalized = normalizedPath(file);
  if (normalized === undefined) return false;
  return (index.get(normalized) ?? []).some(
    ({ startLine, endLine }) => line >= startLine && line <= endLine,
  );
}

function excerptLine(line: string, lineNumber: number): SourceExcerpt {
  const normalized = sanitizeSourceLine(line);
  const codePoints = Array.from(normalized);
  if (codePoints.length <= SOURCE_EXCERPT_MAX_CODE_POINTS) {
    return Object.freeze({
      line: lineNumber,
      text: normalized,
      redacted: false,
      truncated: false,
    });
  }
  return Object.freeze({
    line: lineNumber,
    text: `${codePoints
      .slice(0, SOURCE_EXCERPT_MAX_CODE_POINTS - 1)
      .join("")}…`,
    redacted: false,
    truncated: true,
  });
}

function copyFinding(
  finding: Finding,
  sourceExcerpt: SourceExcerpt | undefined,
): Finding {
  return Object.freeze({
    id: finding.id,
    check: finding.check,
    rule: finding.rule,
    severity: finding.severity,
    message: finding.message,
    ...(finding.location === undefined
      ? {}
      : { location: Object.freeze({ ...finding.location }) }),
    ...(finding.remediation === undefined
      ? {}
      : { remediation: finding.remediation }),
    ...(finding.automaticFix === undefined
      ? {}
      : { automaticFix: finding.automaticFix }),
    ...(sourceExcerpt === undefined
      ? {}
      : { sourceExcerpt: Object.freeze({ ...sourceExcerpt }) }),
    attribution: Object.freeze({
      ...finding.attribution,
      evidence: Object.freeze([...finding.attribution.evidence]),
    }),
  });
}

function copyCheck(
  check: CheckResult,
  findings: readonly Finding[],
): CheckResult {
  return Object.freeze({
    checkId: check.checkId,
    ...(check.target === undefined ? {} : { target: check.target }),
    status: check.status,
    durationMs: check.durationMs,
    findings: Object.freeze([...findings]),
    ...(check.error === undefined
      ? {}
      : { error: Object.freeze({ ...check.error }) }),
    ...(check.skipReason === undefined ? {} : { skipReason: check.skipReason }),
    ...(check.incompleteDisposition === undefined
      ? {}
      : { incompleteDisposition: check.incompleteDisposition }),
  });
}

export function omitSourceExcerpts(
  checks: readonly CheckResult[],
): readonly CheckResult[] {
  return Object.freeze(
    checks.map((check) =>
      copyCheck(
        check,
        check.findings.map((finding) => copyFinding(finding, undefined)),
      ),
    ),
  );
}

function redactedMarker(
  sourceExcerpt: SourceExcerpt | undefined,
): SourceExcerpt | undefined {
  if (sourceExcerpt?.redacted !== true) return undefined;
  return Object.freeze({
    line: sourceExcerpt.line,
    redacted: true,
    truncated: sourceExcerpt.truncated,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export function omitReportSourceExcerpts(report: ScanReport): ScanReport {
  const checks = Object.freeze(
    report.checks.map((check) =>
      copyCheck(
        check,
        check.findings.map((finding) =>
          copyFinding(finding, redactedMarker(finding.sourceExcerpt)),
        ),
      ),
    ),
  );
  return deepFreeze({
    schemaVersion: report.schemaVersion,
    outcome: report.outcome,
    exitCode: report.exitCode,
    repositoryRoot: report.repositoryRoot,
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
    presentationPolicy: { ...report.presentationPolicy },
    summary: summarizeChecks(checks),
    checks,
  });
}

async function captureRegistry(
  snapshotRoot: string,
): Promise<SnapshotRegistry | undefined> {
  try {
    return await captureSnapshotRegistry(snapshotRoot);
  } catch {
    return undefined;
  }
}

export async function enrichSourceExcerpts(
  checks: readonly CheckResult[],
  snapshot: Pick<RepositoryInspection, "snapshotRoot">,
): Promise<readonly CheckResult[]> {
  const secretRanges = secretRangeIndex(checks);
  const registry = await captureRegistry(snapshot.snapshotRoot);
  const requestedLines = new Map<string, Set<number>>();
  for (const check of checks) {
    for (const finding of check.findings) {
      const line = finding.location?.startLine;
      const file = finding.location?.file;
      if (
        finding.check === "secrets" ||
        file === undefined ||
        line === undefined ||
        !Number.isSafeInteger(line) ||
        line < 1 ||
        overlapsSecretLine(secretRanges, file, line)
      ) {
        continue;
      }
      const lines = requestedLines.get(file) ?? new Set<number>();
      lines.add(line);
      requestedLines.set(file, lines);
    }
  }
  const sourceLines = new Map<
    string,
    Promise<ReadonlyMap<number, string> | undefined>
  >();
  if (registry !== undefined) {
    for (const [file, lines] of requestedLines) {
      sourceLines.set(
        file,
        readContainedLines(registry, file, [...lines], {
          maxCodePoints: SOURCE_EXCERPT_MAX_CODE_POINTS + 1,
        }).catch(() => undefined),
      );
    }
  }

  const enrichedChecks = await Promise.all(
    checks.map(async (check) => {
      const findings = await Promise.all(
        check.findings.map(async (finding) => {
          const line = finding.location?.startLine;
          if (!Number.isSafeInteger(line) || line === undefined || line < 1) {
            return copyFinding(finding, undefined);
          }
          const file = finding.location?.file;
          if (
            finding.check === "secrets" ||
            (file !== undefined && overlapsSecretLine(secretRanges, file, line))
          ) {
            return copyFinding(
              finding,
              Object.freeze({
                line,
                redacted: true,
                truncated: false,
              }),
            );
          }
          if (file === undefined) return copyFinding(finding, undefined);
          const lines = await sourceLines.get(file);
          const sourceLine = lines?.get(line);
          return copyFinding(
            finding,
            sourceLine === undefined
              ? undefined
              : excerptLine(sourceLine, line),
          );
        }),
      );
      return copyCheck(check, findings);
    }),
  );

  return Object.freeze(enrichedChecks);
}
