import type {
  Attribution,
  ChangedEntity,
  Finding,
  Observation,
  ObservationEntity,
} from "../core/types.js";
import {
  findingIdentity,
  fingerprintObservation,
  normalizeObservation,
  normalizeRepositoryRelativePath,
} from "./fingerprint.js";

export interface MetricDeltaPolicy {
  readonly limit: number;
  readonly blockWorsening: boolean;
}

const NONE: Attribution = Object.freeze({
  kind: "none",
  staged: false,
  evidence: Object.freeze([]),
});

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

function canonicalText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`Expected canonical ${field}`);
  }
  return value;
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
    fingerprintObservation(baseline) !== fingerprintObservation(target) ||
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

function toFinding(target: Observation, attribution: Attribution): Finding {
  const identity = findingIdentity(target);
  if (identity.scope.kind !== "entity") {
    throw new TypeError("Expected an entity-scoped target metric observation");
  }
  return Object.freeze({
    id: fingerprintObservation(target),
    check: target.check,
    rule: target.rule,
    severity: target.severity,
    message: target.message,
    ...(target.location === undefined ? {} : { location: target.location }),
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
    return toFinding(targetSnapshot, NONE);

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
    return toFinding(targetSnapshot, NONE);
  }

  const evidence = [
    ...(baselineValue === undefined ? [] : [`baseline-value:${baselineValue}`]),
    `entity:${targetSnapshot.identity}`,
    `limit:${policySnapshot.limit}`,
    `reason:${
      targetOnlyAboveLimit
        ? "target-only-above-limit"
        : crossesLimit
          ? "limit-crossing"
          : "worsening-above-limit"
    }`,
    `target-value:${targetValue}`,
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return toFinding(
    targetSnapshot,
    Object.freeze({
      kind: "metric-delta",
      staged: true,
      evidence: Object.freeze(evidence),
    }),
  );
}
