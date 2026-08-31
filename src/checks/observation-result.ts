import {
  compareCodeUnits,
  compareObservationSets,
} from "../attribution/compare.js";
import { collectChangedEntities } from "../attribution/entities.js";
import {
  fingerprintObservation,
  normalizeObservation,
} from "../attribution/fingerprint.js";
import {
  attributeMetricDelta,
  type MetricDeltaPolicy,
} from "../attribution/metrics.js";
import type {
  CheckId,
  ResolvedCheckPolicy,
  ResolvedComplexityPolicy,
  ResolvedDuplicationPolicy,
} from "../config/schema.js";
import { CHECK_IDS } from "../config/schema.js";
import { compareFindings } from "../core/summarize.js";
import type {
  ChangedEntity,
  CheckResult,
  Finding,
  Observation,
} from "../core/types.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  type SnapshotRegistry,
} from "../inspection/snapshot-registry.js";
import type { RepositoryInspection } from "../inspection/types.js";
import type {
  CheckObservationSet,
  CheckRunContext,
  CheckTarget,
} from "./adapter.js";
import { sanitizeCheckTarget } from "./sanitize-target.js";

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

function sameTarget(left: CheckTarget, right: CheckTarget): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.relativeRoot === right.relativeRoot
  );
}

function observations(value: unknown, checkId: string): readonly Observation[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected analyzer observations to be an array");
  }
  return Object.freeze(
    value.map((candidate) => {
      const observation = normalizeObservation(candidate as Observation);
      if (observation.check !== checkId) {
        throw new TypeError("Observation check does not match its adapter");
      }
      return observation;
    }),
  );
}

function snapshotSet(
  value: CheckObservationSet,
  checkId: string,
  target: CheckTarget,
  requiresBaseline: boolean,
): {
  readonly baseline: readonly Observation[];
  readonly target: readonly Observation[];
  readonly projectDelta: boolean;
} {
  const input = record(value, "observation set");
  const returnedCheckId = input.checkId;
  const returnedTarget = sanitizeCheckTarget(input.target as CheckTarget);
  const baseline = observations(input.baselineObservations, checkId);
  const targetObservations = observations(input.targetObservations, checkId);
  const projectDeltaValue = input.projectDelta;
  if (
    projectDeltaValue !== undefined &&
    typeof projectDeltaValue !== "boolean"
  ) {
    throw new TypeError("Expected projectDelta to be a boolean");
  }
  if (returnedCheckId !== checkId || !sameTarget(returnedTarget, target)) {
    throw new TypeError("Observation set does not match its check target");
  }
  if (!requiresBaseline && baseline.length > 0) {
    throw new TypeError("Adapter returned undeclared baseline observations");
  }
  return {
    baseline,
    target: targetObservations,
    projectDelta: projectDeltaValue === true,
  };
}

async function changedEntities(
  context: CheckRunContext,
  targetObservations: readonly Observation[],
  registry: SnapshotRegistry | undefined,
): Promise<readonly ChangedEntity[]> {
  const files = [
    ...new Set(
      targetObservations
        // Only syntax entities can match collectChangedEntities identities.
        // Analyzer entities, such as Knip dependencies in package.json, still
        // participate in baseline comparison and project-delta attribution.
        .filter((observation) =>
          ["function", "class", "method"].includes(
            observation.entity?.kind ?? "",
          ),
        )
        .map((observation) => observation.entity?.file)
        .filter((file): file is string => file !== undefined)
        .filter(
          (file) =>
            (context.changeSet.files.get(file)?.addedRanges.length ?? 0) > 0,
        ),
    ),
  ].sort(compareCodeUnits);
  if (files.length === 0) return Object.freeze([]);
  if (registry === undefined) {
    throw new TypeError("Changed entity source was not validated");
  }

  const entities: ChangedEntity[] = [];
  for (const file of files) {
    const ranges = context.changeSet.files.get(file)?.addedRanges ?? [];
    const source = await readContainedFile(registry, file);
    entities.push(...collectChangedEntities(source, file, ranges));
  }
  return Object.freeze(entities);
}

function hasObservationPaths(input: readonly Observation[]): boolean {
  return input.some(
    (observation) =>
      observation.location?.file !== undefined ||
      observation.entity?.file !== undefined,
  );
}

function ownsPath(relativeRoot: string, path: string): boolean {
  return relativeRoot === "." || path.startsWith(`${relativeRoot}/`);
}

function mostSpecificWorkspace(inspection: RepositoryInspection, path: string) {
  return inspection.workspaces
    .filter((workspace) => ownsPath(workspace.relativeRoot, path))
    .sort(
      (left, right) =>
        right.relativeRoot.split("/").length -
          left.relativeRoot.split("/").length ||
        compareCodeUnits(left.relativeRoot, right.relativeRoot),
    )[0];
}

function validateObservationPaths(
  side: string,
  input: readonly Observation[],
  target: CheckTarget,
  inspection: RepositoryInspection,
  registry: SnapshotRegistry,
): void {
  for (const observation of input) {
    const paths = [observation.location?.file, observation.entity?.file].filter(
      (path): path is string => path !== undefined,
    );
    for (const path of paths) {
      if (registry.resolve(path)?.targetKind !== "file") {
        throw new TypeError(`Unknown ${side} observation path`);
      }
      if (target.kind === "repository") continue;
      const owner = mostSpecificWorkspace(inspection, path);
      if (owner?.relativeRoot !== target.relativeRoot) {
        throw new TypeError(
          `Observation path does not belong to its ${side} target`,
        );
      }
    }
  }
}

async function snapshotRegistry(
  snapshotRoot: string,
  inspection: RepositoryInspection,
): Promise<SnapshotRegistry> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (inspection.snapshotRoot !== canonicalRoot) {
    throw new TypeError("Inspection does not match its repository snapshot");
  }
  return captureSnapshotRegistry(canonicalRoot);
}

function addedRanges(context: CheckRunContext) {
  return [...context.changeSet.files.values()].flatMap((file) =>
    file.status === "deleted"
      ? []
      : file.addedRanges.map((range) => ({ file: file.path, ...range })),
  );
}

function assertUniqueMetricFingerprints(
  side: string,
  input: readonly Observation[],
): void {
  const fingerprints = new Set<string>();
  for (const observation of input) {
    if (observation.metric === undefined) continue;
    const fingerprint = fingerprintObservation(observation);
    if (fingerprints.has(fingerprint)) {
      throw new TypeError(`Duplicate ${side} metric observation fingerprint`);
    }
    fingerprints.add(fingerprint);
  }
}

function effectiveMetricPolicy(
  checkId: string,
  policy: Readonly<ResolvedCheckPolicy>,
): MetricDeltaPolicy | undefined {
  // Vulnerability severity is descriptive evidence, not a user-configured
  // threshold. It participates in ordinary baseline identity comparison.
  if (checkId === "vulnerabilities") return undefined;

  const isComplexity =
    checkId === "cyclomaticComplexity" || checkId === "readabilityComplexity";
  const isDuplication = checkId === "duplication";
  const limit = isComplexity
    ? (policy as ResolvedComplexityPolicy).max
    : isDuplication
      ? (policy as ResolvedDuplicationPolicy).threshold
      : undefined;
  const validLimit = isComplexity
    ? typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0
    : isDuplication
      ? typeof limit === "number" &&
        Number.isFinite(limit) &&
        limit >= 0 &&
        limit <= 100
      : false;
  if (!validLimit || limit === undefined) {
    throw new TypeError("Metric check has no supported effective policy limit");
  }
  const blockWorsening = isComplexity
    ? ((policy as ResolvedComplexityPolicy).blockWorsening ?? false)
    : false;
  if (typeof blockWorsening !== "boolean") {
    throw new TypeError("Metric check has an invalid worsening policy");
  }
  return Object.freeze({ limit, blockWorsening });
}

function metricFindings(
  checkId: string,
  baseline: readonly Observation[],
  target: readonly Observation[],
  entities: readonly ChangedEntity[],
  context: CheckRunContext,
): Finding[] {
  if (!target.some((observation) => observation.metric !== undefined))
    return [];
  if (checkId === "vulnerabilities") return [];
  if (!CHECK_IDS.includes(checkId as CheckId)) {
    throw new TypeError("Metric check has no supported effective policy limit");
  }
  const baselineByFingerprint = new Map<string, Observation>();
  for (const observation of baseline.filter(
    (candidate) => candidate.metric !== undefined,
  )) {
    const fingerprint = fingerprintObservation(observation);
    baselineByFingerprint.set(fingerprint, observation);
  }

  const targetMetricFingerprints = new Set<string>();
  for (const observation of target.filter(
    (candidate) => candidate.metric !== undefined,
  )) {
    const fingerprint = fingerprintObservation(observation);
    targetMetricFingerprints.add(fingerprint);
  }

  if (targetMetricFingerprints.size === 0) return [];

  return target
    .filter((observation) => observation.metric !== undefined)
    .map((observation) => {
      const fingerprint = fingerprintObservation(observation);
      const baselineObservation = baselineByFingerprint.get(fingerprint);
      const file = observation.entity?.file ?? observation.location?.file;
      const resolvedPolicy =
        file === undefined
          ? context.policy
          : context.policyForFile(checkId as CheckId, file, "target");
      const policy = effectiveMetricPolicy(checkId, resolvedPolicy);
      if (policy === undefined) {
        throw new TypeError(
          "Metric check has no supported effective policy limit",
        );
      }
      return attributeMetricDelta(
        baselineObservation,
        observation,
        entities,
        policy,
      );
    });
}

export async function observationCheckResult(
  checkId: string,
  rawSet: CheckObservationSet,
  context: CheckRunContext,
  requiresBaseline: boolean,
): Promise<CheckResult> {
  const set = snapshotSet(rawSet, checkId, context.target, requiresBaseline);
  const hasMetrics = [...set.baseline, ...set.target].some(
    (observation) => observation.metric !== undefined,
  );
  const metricPolicy = hasMetrics
    ? effectiveMetricPolicy(checkId, context.policy)
    : undefined;
  assertUniqueMetricFingerprints("baseline", set.baseline);
  assertUniqueMetricFingerprints("target", set.target);
  const [baselineRegistry, targetRegistry] = await Promise.all([
    hasObservationPaths(set.baseline)
      ? snapshotRegistry(
          context.snapshots.baselineDir,
          context.baselineInspection,
        )
      : undefined,
    hasObservationPaths(set.target)
      ? snapshotRegistry(context.snapshots.targetDir, context.targetInspection)
      : undefined,
  ]);
  if (baselineRegistry !== undefined)
    validateObservationPaths(
      "baseline",
      set.baseline,
      context.target,
      context.baselineInspection,
      baselineRegistry,
    );
  if (targetRegistry !== undefined)
    validateObservationPaths(
      "target",
      set.target,
      context.target,
      context.targetInspection,
      targetRegistry,
    );
  const entities = await changedEntities(context, set.target, targetRegistry);
  const compareAllObservations =
    checkId === "vulnerabilities" && metricPolicy === undefined;
  const nonMetricFindings = compareObservationSets(
    set.baseline.filter(
      (observation) =>
        compareAllObservations || observation.metric === undefined,
    ),
    set.target.filter(
      (observation) =>
        compareAllObservations || observation.metric === undefined,
    ),
    {
      changedPaths: [...context.changeSet.files.values()]
        .filter((file) => file.status !== "deleted")
        .map((file) => file.path),
      changedEntityIdentities: entities.map((entity) => entity.identity),
      repositoryDelta:
        context.target.kind === "repository" && !context.changeSet.isEmpty,
      projectDelta: set.projectDelta,
      addedRanges: addedRanges(context),
      syntaxOwnership: true,
    },
  );
  const metrics = metricFindings(
    checkId,
    set.baseline,
    set.target,
    entities,
    context,
  );
  return {
    checkId,
    target: context.target.id,
    status: "completed",
    durationMs: 0,
    findings: [...nonMetricFindings, ...metrics].sort(compareFindings),
  };
}
