import { createHash } from "node:crypto";
import type {
  FindingIdentity,
  FindingIdentityScope,
  Observation,
  ObservationEntity,
  ObservationMetric,
  Severity,
  SourceLocation,
} from "../core/types.js";
import { displayLabel, displayProse } from "../core/display-text.js";

const WINDOWS_DRIVE = /^[A-Za-z]:/;
const UNSAFE_PATH_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Repository paths are bounded by Unicode code points, not UTF-16 units. */
export const MAX_REPOSITORY_PATH_CODE_POINTS = 4096;
export const MAX_REPOSITORY_SEGMENT_CODE_POINTS = 255;
// Internal keys may combine multiple maximum-length repository paths and a
// lockfile's bounded dependency ancestry before they are hashed.
const MAX_CANONICAL_IDENTITY_LENGTH = 128 * 1024;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function invalidPath(file: unknown): never {
  throw new TypeError("Expected a normalized repository-relative path");
}

export function normalizeRepositoryRelativePath(file: string): string {
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    UNSAFE_PATH_CHARACTER.test(file) ||
    codePointLength(file) > MAX_REPOSITORY_PATH_CODE_POINTS
  ) {
    return invalidPath(file);
  }
  const portable = file.replaceAll("\\", "/");
  if (
    portable.startsWith("/") ||
    portable.startsWith("//") ||
    WINDOWS_DRIVE.test(portable)
  ) {
    return invalidPath(file);
  }

  const normalized: string[] = [];
  for (const segment of portable.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (
      segment === ".." ||
      UNSAFE_PATH_CHARACTER.test(segment) ||
      codePointLength(segment) > MAX_REPOSITORY_SEGMENT_CODE_POINTS
    ) {
      return invalidPath(file);
    }
    normalized.push(segment);
  }
  if (normalized.length === 0) return invalidPath(file);
  return normalized.join("/");
}

function canonicalText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    UNSAFE_PATH_CHARACTER.test(value)
  ) {
    throw new TypeError(`Expected canonical ${field}`);
  }
  return displayLabel(value, field);
}

function canonicalIdentityText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CANONICAL_IDENTITY_LENGTH ||
    value.trim() !== value ||
    UNSAFE_PATH_CHARACTER.test(value)
  ) {
    throw new TypeError(`Expected canonical ${field}`);
  }
  return value;
}

function coordinate(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Expected ${field} to be a positive safe integer`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

export function normalizeSourceLocation(
  location: SourceLocation,
): SourceLocation {
  const input = record(location, "location");
  const file = input.file;
  const startLineValue = input.startLine;
  const startColumnValue = input.startColumn;
  const endLineValue = input.endLine;
  const endColumnValue = input.endColumn;
  const startLine = coordinate(startLineValue, "startLine");
  const startColumn = coordinate(startColumnValue, "startColumn");
  const endLine = coordinate(endLineValue, "endLine");
  const endColumn = coordinate(endColumnValue, "endColumn");
  return Object.freeze({
    file: normalizeRepositoryRelativePath(file as string),
    ...(startLine === undefined ? {} : { startLine }),
    ...(startColumn === undefined ? {} : { startColumn }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(endColumn === undefined ? {} : { endColumn }),
  });
}

function normalizeEntity(value: unknown): ObservationEntity {
  const input = record(value, "entity");
  const kind = input.kind;
  const name = input.name;
  const file = input.file;
  return Object.freeze({
    kind: canonicalText(kind, "entity kind"),
    name: canonicalText(name, "entity name"),
    file: normalizeRepositoryRelativePath(file as string),
  });
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Expected ${field} to be a finite number`);
  }
  return value;
}

function normalizeMetric(value: unknown): ObservationMetric {
  const input = record(value, "metric");
  const name = input.name;
  const metricValue = input.value;
  const limitValue = input.limit;
  const limit =
    limitValue === undefined
      ? undefined
      : finiteNumber(limitValue, "metric limit");
  return Object.freeze({
    name: canonicalText(name, "metric name"),
    value: finiteNumber(metricValue, "metric value"),
    ...(limit === undefined ? {} : { limit }),
  });
}

function severity(value: unknown): Severity {
  if (value !== "info" && value !== "warning" && value !== "error") {
    throw new TypeError("Expected severity to be info, warning, or error");
  }
  return value;
}

function prose(value: unknown, field: string): string {
  return displayProse(value, field, { allowEmpty: true });
}

/**
 * Copies untrusted adapter output into a deeply immutable, plain snapshot.
 * Only documented fields are read, and each field on the untrusted input is
 * read exactly once.
 */
export function normalizeObservation(observation: Observation): Observation {
  const input = record(observation, "observation");
  const checkValue = input.check;
  const ruleValue = input.rule;
  const identityValue = input.identity;
  const comparisonIdentityValue = input.comparisonIdentity;
  const severityValue = input.severity;
  const messageValue = input.message;
  const locationValue = input.location;
  const entityValue = input.entity;
  const metricValue = input.metric;
  const remediationValue = input.remediation;

  const location =
    locationValue === undefined
      ? undefined
      : normalizeSourceLocation(locationValue as SourceLocation);
  const entity =
    entityValue === undefined ? undefined : normalizeEntity(entityValue);
  const metric =
    metricValue === undefined ? undefined : normalizeMetric(metricValue);
  const remediation =
    remediationValue === undefined
      ? undefined
      : prose(remediationValue, "remediation");
  const comparisonIdentity =
    comparisonIdentityValue === undefined
      ? undefined
      : canonicalIdentityText(comparisonIdentityValue, "comparison identity");

  return Object.freeze({
    check: canonicalText(checkValue, "check"),
    rule: canonicalText(ruleValue, "rule"),
    identity: canonicalIdentityText(identityValue, "identity"),
    ...(comparisonIdentity === undefined ? {} : { comparisonIdentity }),
    severity: severity(severityValue),
    message: prose(messageValue, "message"),
    ...(location === undefined ? {} : { location }),
    ...(entity === undefined ? {} : { entity }),
    ...(metric === undefined ? {} : { metric }),
    ...(remediation === undefined ? {} : { remediation }),
  });
}

function locationScope(location: SourceLocation): FindingIdentityScope {
  const normalized = normalizeSourceLocation(location);
  return { kind: "location", ...normalized };
}

function findingIdentityFromSnapshot(
  observation: Observation,
): FindingIdentity {
  // Validate the report location even when the entity is the preferred identity.
  if (observation.location !== undefined)
    normalizeSourceLocation(observation.location);

  let scope: FindingIdentityScope;
  if (observation.entity !== undefined) {
    scope = {
      kind: "entity",
      entityKind: canonicalText(observation.entity.kind, "entity kind"),
      name: canonicalText(observation.entity.name, "entity name"),
      file: normalizeRepositoryRelativePath(observation.entity.file),
    };
  } else if (observation.location !== undefined) {
    scope = locationScope(observation.location);
  } else {
    scope = { kind: "repository" };
  }

  const metricName =
    observation.metric === undefined
      ? undefined
      : canonicalText(observation.metric.name, "metric name");
  return {
    check: canonicalText(observation.check, "check"),
    rule: canonicalText(observation.rule, "rule"),
    identity: canonicalIdentityText(observation.identity, "identity"),
    scope,
    ...(metricName === undefined ? {} : { metricName }),
  };
}

export function findingIdentity(observation: Observation): FindingIdentity {
  return findingIdentityFromSnapshot(normalizeObservation(observation));
}

function canonicalIdentity(identity: FindingIdentity): string {
  const scope = identity.scope;
  const canonicalScope =
    scope.kind === "location"
      ? [
          "location",
          scope.file,
          scope.startLine ?? null,
          scope.startColumn ?? null,
          scope.endLine ?? null,
          scope.endColumn ?? null,
        ]
      : scope.kind === "entity"
        ? ["entity", scope.entityKind, scope.name, scope.file]
        : ["repository"];
  return JSON.stringify([
    "zedbee-finding-v1",
    identity.check,
    identity.rule,
    identity.identity,
    canonicalScope,
    identity.metricName ?? null,
  ]);
}

export function fingerprintObservation(observation: Observation): string {
  const snapshot = normalizeObservation(observation);
  return createHash("sha256")
    .update(canonicalIdentity(findingIdentityFromSnapshot(snapshot)), "utf8")
    .digest("hex");
}
