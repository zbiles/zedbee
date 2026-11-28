import { canonicalText } from "../core/canonical-text.js";
import { compareCodeUnits } from "../core/compare.js";
import type {
  Attribution,
  ChangedEntity,
  Finding,
  Observation,
  ObservationEntity,
} from "../core/types.js";
import {
  findingIdentityFromSnapshot,
  fingerprintSnapshot,
  normalizeObservation,
  normalizeRepositoryRelativePath,
} from "./fingerprint.js";
import { NO_ATTRIBUTION } from "./range.js";

export interface MetricDeltaPolicy {
  readonly limit: number;
  readonly blockWorsening: boolean;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}


function normalizeChangedEntities(
  entities: readonly ChangedEntity[],
): ReadonlyMap<string, ChangedEntity> {
  if (!Array.isArray(entities))
    throw new TypeError("Expected changed entities to be an array");
  const result = new Map<string, ChangedEntity>();
  for (const candidate of entities) {
    const input = record(candidate, "changed entity");
    const kind = canonicalText(input.kind, "changed entity kind");
    const name = canonicalText(input.name, "changed entity name");
    const file = normalizeRepositoryRelativePath(input.file as string);
    const identity = canonicalText(input.identity, "changed entity identity");
    const startLine = input.startLine;
    const endLine = input.endLine;
    if (
      typeof startLine !== "number" ||
      typeof endLine !== "number" ||
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    ) {
      throw new TypeError("Expected a valid changed entity span");
    }
    const snapshot = Object.freeze({
      kind,
      name,
      file,
      startLine,
      endLine,
      identity,
    });
    const identityPrefix = `${kind}:${file}:`;
    const payload = identity.slice(identityPrefix.length);
    const qualifiedSegments = payload.split("/");
    let qualifiedIdentityIsValid =
      identity.startsWith(identityPrefix) && qualifiedSegments.length > 1;
    for (const [index, segment] of qualifiedSegments.entries()) {
      if (!qualifiedIdentityIsValid) break;
      const separator = segment.indexOf("=");
      if (separator < 1 || separator === segment.length - 1) {
        qualifiedIdentityIsValid = false;
        break;
      }
      const ownerKind = segment.slice(0, separator);
      let ownerName: string;
      try {
        ownerName = decodeURIComponent(segment.slice(separator + 1));
      } catch {
        qualifiedIdentityIsValid = false;
        break;
      }
      canonicalText(ownerKind, "changed entity owner kind");
      canonicalText(ownerName, "changed entity owner name");
      if (segment !== `${ownerKind}=${encodeURIComponent(ownerName)}`) {
        qualifiedIdentityIsValid = false;
      }
      if (
        index === qualifiedSegments.length - 1 &&
        (ownerKind !== kind || ownerName !== name)
      ) {
        qualifiedIdentityIsValid = false;
      }
    }
    if (identity !== `${kind}:${file}:${name}` && !qualifiedIdentityIsValid) {
      throw new TypeError(
        "Expected changed entity identity to match its canonical fields",
      );
    }
    result.set(identity, snapshot);
  }
  return result;
}

function normalizePolicy(policy: MetricDeltaPolicy): MetricDeltaPolicy {
  const input = record(policy, "metric delta policy");
  const limit = input.limit;
  const blockWorsening = input.blockWorsening;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new TypeError("Expected metric delta limit to be finite");
  }
  if (typeof blockWorsening !== "boolean") {
    throw new TypeError("Expected blockWorsening to be boolean");
  }
  return Object.freeze({ limit, blockWorsening });
}

function requireMetricEntity(
  observation: Observation,
  side: string,
): ObservationEntity {
  if (observation.metric === undefined || observation.entity === undefined) {
    throw new TypeError(
      `Expected ${side} metric observation to have an entity and metric`,
    );
  }
  return observation.entity;
}

function assertSameMetric(baseline: Observation, target: Observation): void {
  const baselineEntity = requireMetricEntity(baseline, "baseline");
  const targetEntity = requireMetricEntity(target, "target");
  if (
    fingerprintSnapshot(baseline) !== fingerprintSnapshot(target) ||
    baseline.identity !== target.identity ||
    baseline.metric?.name !== target.metric?.name ||
    baselineEntity.kind !== targetEntity.kind ||
    baselineEntity.name !== targetEntity.name ||
    baselineEntity.file !== targetEntity.file
  ) {
    throw new TypeError(
      "Expected baseline and target to describe the same entity metric fingerprint",
    );
  }
}

function matchesChangedEntity(
  target: Observation,
  changed: ChangedEntity | undefined,
): boolean {
  const entity = target.entity;
  return (
    changed !== undefined &&
    entity !== undefined &&
    changed.identity === target.identity &&
    changed.kind === entity.kind &&
    changed.name === entity.name &&
    changed.file === entity.file
  );
}

function toFinding(
  target: Observation,
  attribution: Attribution,
  policy: MetricDeltaPolicy,
  baseline?: Observation,
): Finding {
  const identity = findingIdentityFromSnapshot(target);
  const entity = requireMetricEntity(target, "target");
  if (identity.scope.kind !== "entity") {
    throw new TypeError("Expected an entity-scoped target metric observation");
  }
  return Object.freeze({
    id: fingerprintSnapshot(target),
    check: target.check,
    rule: target.rule,
    severity: target.severity,
    message:
      target.metric?.name === "cyclomatic-complexity" ||
      target.metric?.name === "readability-complexity"
        ? `${target.metric.name === "cyclomatic-complexity" ? "Cyclomatic" : "Readability"} complexity ${target.metric.value} (limit ${policy.limit}${baseline?.metric !== undefined && target.metric.value > baseline.metric.value ? `; baseline ${baseline.metric.value}` : ""}).`
        : target.message,
    ...(target.location === undefined
      ? { location: Object.freeze({ file: entity.file }) }
      : { location: target.location }),
    ...(target.remediation === undefined
      ? {}
      : { remediation: target.remediation }),
    attribution,
  });
}

export function attributeMetricDelta(
  baseline: Observation | undefined,
  target: Observation,
  changedEntities: readonly ChangedEntity[],
  policy: MetricDeltaPolicy,
): Finding;
export function attributeMetricDelta(
  baseline: Observation,
  target: undefined,
  changedEntities: readonly ChangedEntity[],
  policy: MetricDeltaPolicy,
): undefined;
export function attributeMetricDelta(
  baseline: Observation | undefined,
  target: Observation | undefined,
  changedEntities: readonly ChangedEntity[],
  policy: MetricDeltaPolicy,
): Finding | undefined {
  const policySnapshot = normalizePolicy(policy);
  const changed = normalizeChangedEntities(changedEntities);
  return attributePreparedMetricDelta(
    baseline,
    target,
    changed,
    policySnapshot,
  );
}

/** Validate and snapshot entity ownership once for one analyzer result. */
export function prepareMetricAttribution(
  changedEntities: readonly ChangedEntity[],
) {
  const changed = normalizeChangedEntities(changedEntities);
  return (
    baseline: Observation | undefined,
    target: Observation,
    policy: MetricDeltaPolicy,
  ): Finding =>
    attributePreparedMetricDelta(
      baseline,
      target,
      changed,
      normalizePolicy(policy),
    )!;
}

function attributePreparedMetricDelta(
  baseline: Observation | undefined,
  target: Observation | undefined,
  changed: ReadonlyMap<string, ChangedEntity>,
  policySnapshot: MetricDeltaPolicy,
): Finding | undefined {
  if (target === undefined) {
    if (baseline === undefined)
      throw new TypeError("Expected a baseline or target metric observation");
    requireMetricEntity(normalizeObservation(baseline), "baseline");
    return undefined;
  }

  const targetSnapshot = normalizeObservation(target);
  requireMetricEntity(targetSnapshot, "target");
  const baselineSnapshot =
    baseline === undefined ? undefined : normalizeObservation(baseline);
  if (baselineSnapshot !== undefined)
    assertSameMetric(baselineSnapshot, targetSnapshot);

  const changedEntity = changed.get(targetSnapshot.identity);
  if (!matchesChangedEntity(targetSnapshot, changedEntity))
    return toFinding(
      targetSnapshot,
      NO_ATTRIBUTION,
      policySnapshot,
      baselineSnapshot,
    );

  const targetValue = targetSnapshot.metric!.value;
  const baselineValue = baselineSnapshot?.metric?.value;
  const aboveLimit = targetValue > policySnapshot.limit;
  const crossesLimit =
    baselineValue !== undefined &&
    baselineValue <= policySnapshot.limit &&
    aboveLimit;
  const worsensAboveLimit =
    baselineValue !== undefined &&
    baselineValue > policySnapshot.limit &&
    targetValue > baselineValue &&
    policySnapshot.blockWorsening;
  const targetOnlyAboveLimit = baselineValue === undefined && aboveLimit;
  if (!crossesLimit && !worsensAboveLimit && !targetOnlyAboveLimit) {
    return toFinding(
      targetSnapshot,
      NO_ATTRIBUTION,
      policySnapshot,
      baselineSnapshot,
    );
  }

  const evidence = metricDeltaEvidence(
    targetSnapshot.identity,
    policySnapshot.limit,
    baselineValue,
    targetValue,
    targetOnlyAboveLimit,
    crossesLimit,
  );
  return toFinding(
    targetSnapshot,
    Object.freeze({
      kind: "metric-delta",
      staged: true,
      evidence: Object.freeze(evidence),
    }),
    policySnapshot,
    baselineSnapshot,
  );
}

function metricDeltaEvidence(
  identity: string,
  limit: number,
  baselineValue: number | undefined,
  targetValue: number,
  targetOnlyAboveLimit: boolean,
  crossesLimit: boolean,
): string[] {
  const reason = targetOnlyAboveLimit
    ? "target-only-above-limit"
    : crossesLimit
      ? "limit-crossing"
      : "worsening-above-limit";
  return [
    ...(baselineValue === undefined ? [] : [`baseline-value:${baselineValue}`]),
    `entity:${identity}`,
    `limit:${limit}`,
    `reason:${reason}`,
    `target-value:${targetValue}`,
  ].sort(compareCodeUnits);
}
