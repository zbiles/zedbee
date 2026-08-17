import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import type { DependencyRecord } from "./inventory/types.js";
import { osvQueryKey } from "./osv/client.js";
import type { OsvAdvisory } from "./osv/types.js";

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
  return advisory.affected
    .filter(
      (affected) =>
        affected.package.ecosystem.toLowerCase() === "npm" &&
        affected.package.name === dependency.name,
    )
    .flatMap(({ ranges }) => ranges)
    .flatMap(({ events }) => events)
    .flatMap(({ fixed }) => (fixed === undefined ? [] : [fixed]))
    .sort(compareCodeUnits)[0];
}

export function normalizeOsvInventory(
  inventory: readonly DependencyRecord[],
  advisoriesByQuery: ReadonlyMap<string, readonly OsvAdvisory[]>,
): readonly Observation[] {
  const observations: Observation[] = [];
  for (const dependency of inventory) {
    const advisories = advisoriesByQuery.get(osvQueryKey(dependency)) ?? [];
    for (const advisory of advisories) {
      const fixed = fixedVersion(advisory, dependency);
      const score = maximumNumericSeverity(advisory);
      const reference = `https://osv.dev/${encodeURIComponent(advisory.id)}`;
      observations.push({
        check: "vulnerabilities",
        rule: advisory.id,
        identity: JSON.stringify([
          advisory.id,
          dependency.ecosystem,
          dependency.name,
          dependency.version,
          dependency.lockfilePath,
          dependency.importer ?? null,
          dependency.dependencyPath ?? null,
        ]),
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
