import type {
  Attribution,
  Finding,
  FindingIdentity,
  Observation,
  SourceLocation,
} from "../core/types.js";
import {
  findingIdentity,
  fingerprintObservation,
  normalizeObservation,
  normalizeRepositoryRelativePath,
} from "./fingerprint.js";
import { compareCodeUnits } from "../core/compare.js";

export interface ObservationComparisonEvidence {
  readonly changedPaths: readonly string[];
  readonly changedEntityIdentities: readonly string[];
  readonly repositoryDelta: boolean;
  readonly projectDelta?: boolean;
  readonly addedRanges?: readonly {
    readonly file: string;
    readonly start: number;
    readonly end: number;
  }[];
  readonly syntaxOwnership?: boolean;
}

interface NormalizedTarget {
  readonly fingerprint: string;
  readonly comparisonFingerprint: string;
  readonly observation: Observation;
  readonly identity: FindingIdentity;
  readonly location?: SourceLocation;
  readonly sortKey: string;
}

function comparisonFingerprint(observation: Observation): string {
  if (observation.comparisonIdentity !== undefined) {
    return JSON.stringify([
      observation.check,
      observation.rule,
      observation.comparisonIdentity,
    ]);
  }
  const fingerprint = fingerprintObservation(observation);
  return fingerprint;
}

const NONE: Attribution = Object.freeze({
  kind: "none",
  staged: false,
  evidence: Object.freeze([]),
});

function canonicalEntityIdentity(identity: string): string {
  if (
    typeof identity !== "string" ||
    identity.length === 0 ||
    identity.trim() !== identity ||
    /[\u0000-\u001f\u007f]/u.test(identity)
  ) {
    throw new TypeError("Expected a canonical changed entity identity");
  }
  return identity;
}

export { compareCodeUnits } from "../core/compare.js";

function normalizeTarget(observation: Observation): NormalizedTarget {
  const snapshot = normalizeObservation(observation);
  const identity = findingIdentity(snapshot);
  const fingerprint = fingerprintObservation(snapshot);
  const pairedFingerprint = comparisonFingerprint(snapshot);
  const location = snapshot.location;
  const sortKey = JSON.stringify([
    fingerprint,
    pairedFingerprint,
    snapshot.check,
    snapshot.rule,
    location?.file ?? "",
    location?.startLine ?? null,
    location?.startColumn ?? null,
    location?.endLine ?? null,
    location?.endColumn ?? null,
    snapshot.severity,
    snapshot.message,
    snapshot.remediation ?? "",
    snapshot.automaticFix === undefined
      ? ""
      : JSON.stringify(snapshot.automaticFix.command),
  ]);
  return {
    fingerprint,
    comparisonFingerprint: pairedFingerprint,
    observation: snapshot,
    identity,
    ...(location === undefined ? {} : { location }),
    sortKey,
  };
}

function baselineCounts(
  observations: readonly Observation[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const observation of observations) {
    const fingerprint = comparisonFingerprint(
      normalizeObservation(observation),
    );
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

function comparisonAttribution(
  target: NormalizedTarget,
  changedPaths: ReadonlySet<string>,
  changedEntityIdentities: ReadonlySet<string>,
  repositoryDelta: boolean,
  addedRanges: ReadonlyMap<string, readonly { start: number; end: number }[]>,
  syntaxOwnership: boolean,
  projectDelta: boolean,
): Attribution {
  const evidence: string[] = [];
  const scope = target.identity.scope;
  if (scope.kind === "location") {
    const ranges = addedRanges.get(scope.file) ?? [];
    const startLine = scope.startLine;
    const endLine = scope.endLine ?? startLine;
    const overlap =
      startLine === undefined
        ? undefined
        : ranges.find(
            (range) =>
              startLine <= range.end && (endLine ?? startLine) >= range.start,
          );
    if (overlap !== undefined) {
      evidence.push(
        `staged-range:${scope.file}:${overlap.start}-${overlap.end}`,
      );
    } else if (startLine === undefined && changedPaths.has(scope.file)) {
      evidence.push(`changed-path:${scope.file}`);
    }
  } else if (
    scope.kind === "entity" &&
    changedEntityIdentities.has(target.observation.identity)
  ) {
    evidence.push(`changed-entity:${target.observation.identity}`);
  } else if (scope.kind === "repository" && repositoryDelta) {
    evidence.push("repository-delta");
  }
  if (evidence.length === 0 && projectDelta) {
    evidence.push("project-delta");
  }
  if (evidence.length === 0) return NONE;

  evidence.sort(compareCodeUnits);
  evidence.push(`target-only:${target.fingerprint}`);
  return {
    kind:
      scope.kind === "location" && evidence[0]?.startsWith("staged-range:")
        ? "range-overlap"
        : scope.kind === "entity" && syntaxOwnership
          ? "syntax-ownership"
          : "baseline-comparison",
    staged: true,
    evidence,
  };
}

function finding(target: NormalizedTarget, attribution: Attribution): Finding {
  const observation = target.observation;
  return {
    id: target.fingerprint,
    check: observation.check,
    rule: observation.rule,
    severity: observation.severity,
    message: observation.message,
    ...(target.location === undefined ? {} : { location: target.location }),
    ...(observation.remediation === undefined
      ? {}
      : { remediation: observation.remediation }),
    ...(observation.automaticFix === undefined
      ? {}
      : { automaticFix: observation.automaticFix }),
    attribution,
  };
}

export function compareObservationSets(
  baseline: readonly Observation[],
  target: readonly Observation[],
  evidence: ObservationComparisonEvidence,
): Finding[] {
  const changedPaths = new Set(
    evidence.changedPaths.map(normalizeRepositoryRelativePath),
  );
  const changedEntityIdentities = new Set(
    evidence.changedEntityIdentities.map(canonicalEntityIdentity),
  );
  const addedRanges = new Map<string, { start: number; end: number }[]>();
  for (const candidate of evidence.addedRanges ?? []) {
    const file = normalizeRepositoryRelativePath(candidate.file);
    if (
      !Number.isSafeInteger(candidate.start) ||
      !Number.isSafeInteger(candidate.end) ||
      candidate.start < 1 ||
      candidate.end < candidate.start
    ) {
      throw new TypeError("Expected a valid staged line range");
    }
    const ranges = addedRanges.get(file) ?? [];
    ranges.push({ start: candidate.start, end: candidate.end });
    addedRanges.set(file, ranges);
  }
  const remainingBaseline = baselineCounts(baseline);
  const normalizedTargets = target
    .map(normalizeTarget)
    .sort((left, right) => compareCodeUnits(left.sortKey, right.sortKey));

  const findings = normalizedTargets.map((normalized): Finding => {
    const remaining =
      remainingBaseline.get(normalized.comparisonFingerprint) ?? 0;
    if (remaining > 0) {
      remainingBaseline.set(normalized.comparisonFingerprint, remaining - 1);
      return finding(normalized, NONE);
    }
    return finding(
      normalized,
      comparisonAttribution(
        normalized,
        changedPaths,
        changedEntityIdentities,
        evidence.repositoryDelta,
        addedRanges,
        evidence.syntaxOwnership === true,
        evidence.projectDelta === true,
      ),
    );
  });

  return findings.sort(
    (left, right) =>
      compareCodeUnits(left.id, right.id) ||
      compareCodeUnits(JSON.stringify(left), JSON.stringify(right)),
  );
}
