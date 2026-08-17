import { SOURCE_EXCERPT_MAX_CODE_POINTS } from "../checks/sanitize-result.js";
import type { CheckResult, Finding, SourceExcerpt } from "../core/types.js";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import { readContainedFile } from "../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  type SnapshotRegistry,
} from "../inspection/snapshot-registry.js";
import type { RepositoryInspection } from "../inspection/types.js";
import { sanitizeSourceLine } from "../reporting/source-line.js";

const SOURCE_LINE_ENDING = /\r\n|[\n\r\u2028\u2029]/u;

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
    ...(finding.location === undefined ? {} : { location: finding.location }),
    ...(finding.remediation === undefined
      ? {}
      : { remediation: finding.remediation }),
    ...(sourceExcerpt === undefined ? {} : { sourceExcerpt }),
    attribution: finding.attribution,
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
    ...(check.error === undefined ? {} : { error: check.error }),
    ...(check.skipReason === undefined ? {} : { skipReason: check.skipReason }),
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
  const sourceLines = new Map<string, Promise<readonly string[] | undefined>>();

  const readLines = (
    repositoryPath: string,
  ): Promise<readonly string[] | undefined> => {
    if (registry === undefined) return Promise.resolve(undefined);
    const cached = sourceLines.get(repositoryPath);
    if (cached !== undefined) return cached;
    const read = readContainedFile(registry, repositoryPath)
      .then((source) => source.split(SOURCE_LINE_ENDING))
      .catch(() => undefined);
    sourceLines.set(repositoryPath, read);
    return read;
  };

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
          const lines = await readLines(file);
          const sourceLine = lines?.[line - 1];
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
