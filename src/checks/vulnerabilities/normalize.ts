import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import type { DependencyRecord } from "./inventory/types.js";
import { osvQueryKey } from "./osv/client.js";
import type { OsvAdvisory } from "./osv/types.js";
import semver from "semver";

const severityByAdvisory = new WeakMap<OsvAdvisory, number | undefined>();
const fixedByAdvisory = new WeakMap<
  OsvAdvisory,
  Map<string, string | undefined>
>();

function maximumNumericSeverity(advisory: OsvAdvisory): number | undefined {
  const values = advisory.severity
    .map(({ score }) => Number(score))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 10);
  return values.length === 0 ? undefined : Math.max(...values);
}

function fixedVersion(
  advisory: OsvAdvisory,
  dependency: DependencyRecord,
): string | undefined {
  const fixedVersions = advisory.affected
    .filter(
      (affected) =>
        affected.package.ecosystem.toLowerCase() === "npm" &&
        affected.package.name === dependency.name,
    )
    .flatMap(({ ranges }) => ranges)
    .flatMap(({ events }) => events)
    .flatMap(({ fixed }) => (fixed === undefined ? [] : [fixed]))
    .filter((fixed) => semver.valid(fixed) !== null);
  const candidates =
    semver.valid(dependency.version) === null
      ? fixedVersions
      : fixedVersions.filter((fixed) =>
          semver.gt(fixed, dependency.version),
        );
  return [...candidates].sort(semver.compare)[0];
}

function cachedSeverity(advisory: OsvAdvisory): number | undefined {
  if (severityByAdvisory.has(advisory)) {
    return severityByAdvisory.get(advisory);
  }
  const score = maximumNumericSeverity(advisory);
  severityByAdvisory.set(advisory, score);
  return score;
}

function cachedFixedVersion(
  advisory: OsvAdvisory,
  dependency: DependencyRecord,
  queryKey: string,
): string | undefined {
  let inner = fixedByAdvisory.get(advisory);
  if (inner === undefined) {
    inner = new Map<string, string | undefined>();
    fixedByAdvisory.set(advisory, inner);
  }
  if (inner.has(queryKey)) {
    return inner.get(queryKey);
  }
  const fixed = fixedVersion(advisory, dependency);
  inner.set(queryKey, fixed);
  return fixed;
}

export function normalizeOsvInventory(
  inventory: readonly DependencyRecord[],
  advisoriesByQuery: ReadonlyMap<string, readonly OsvAdvisory[]>,
): readonly Observation[] {
  const observations: Observation[] = [];
  for (const dependency of inventory) {
    const queryKey = osvQueryKey(dependency);
    const advisories = advisoriesByQuery.get(queryKey) ?? [];
    for (const advisory of advisories) {
      const fixed = cachedFixedVersion(advisory, dependency, queryKey);
      const score = cachedSeverity(advisory);
      const reference = `https://osv.dev/${encodeURIComponent(advisory.id)}`;
      const identity = JSON.stringify([
        advisory.id,
        dependency.ecosystem,
        dependency.name,
        dependency.version,
        dependency.lockfilePath,
        dependency.importer ?? null,
        dependency.dependencyPath ?? null,
      ]);
      observations.push({
        check: "vulnerabilities",
        rule: advisory.id,
        identity,
        // Lockfile coordinates are for display; entry movement is not a new
        // advisory or dependency occurrence.
        comparisonIdentity: identity,
        severity: "error",
        message: `${advisory.id} affects npm package ${dependency.name}@${dependency.version}${fixed === undefined ? "" : `; fixed in ${fixed}`} (${reference})`,
        location: {
          file: dependency.lockfilePath,
          ...(dependency.line === undefined
            ? {}
            : { startLine: dependency.line }),
        },
        ...(score === undefined
          ? {}
          : { metric: { name: "cvss", value: score } }),
        ...(fixed === undefined
          ? {}
          : {
              remediation: `Upgrade ${dependency.name} to ${fixed} or later.`,
            }),
      });
    }
  }
  return Object.freeze(
    observations.sort((left, right) =>
      compareCodeUnits(left.identity, right.identity),
    ),
  );
}
