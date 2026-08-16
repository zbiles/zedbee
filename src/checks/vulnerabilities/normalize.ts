import { isAbsolute, relative, resolve } from "node:path";
import type { Observation } from "../../core/types.js";
import { compareCodeUnits } from "../../core/compare.js";
import { osvReportSchema, type OsvVulnerability } from "./osv-schema.js";

const INVALID_REPORT = "OSV-Scanner returned an invalid report";

function relativeSourcePath(snapshotRoot: string, sourcePath: string): string {
  const canonicalRoot = resolve(snapshotRoot);
  const canonicalSource = isAbsolute(sourcePath)
    ? resolve(sourcePath)
    : resolve(canonicalRoot, sourcePath);
  const result = relative(canonicalRoot, canonicalSource).replaceAll("\\", "/");
  if (
    result.length === 0 ||
    result === ".." ||
    result.startsWith("../") ||
    isAbsolute(result)
  ) {
    throw new TypeError(INVALID_REPORT);
  }
  return result;
}

function maximumNumericSeverity(
  vulnerability: OsvVulnerability,
): number | undefined {
  const values = (vulnerability.severity ?? [])
    .map(({ score }) => Number(score))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 10);
  return values.length === 0 ? undefined : Math.max(...values);
}

function fixedVersion(
  vulnerability: OsvVulnerability,
  ecosystem: string,
  packageName: string,
): string | undefined {
  const fixed = (vulnerability.affected ?? [])
    .filter(
      (affected) =>
        (affected.package?.ecosystem === undefined ||
          affected.package.ecosystem === ecosystem) &&
        (affected.package?.name === undefined ||
          affected.package.name === packageName),
    )
    .flatMap((affected) => affected.ranges ?? [])
    .flatMap((range) => range.events ?? [])
    .map((event) => event.fixed)
    .filter((candidate): candidate is string => candidate !== undefined)
    .sort(compareCodeUnits);
  return fixed[0];
}

export function normalizeOsvReport(
  rawReport: string,
  snapshotRoot: string,
): readonly Observation[] {
  try {
    const parsed: unknown = JSON.parse(rawReport);
    rawReport = "";
    const report = osvReportSchema.parse(parsed);
    const observations: Observation[] = [];
    for (const result of report.results) {
      const dependencyPath = relativeSourcePath(
        snapshotRoot,
        result.source.path,
      );
      for (const item of result.packages) {
        const { ecosystem, name, version } = item.package;
        for (const vulnerability of item.vulnerabilities ?? []) {
          const fixed = fixedVersion(vulnerability, ecosystem, name);
          const score = maximumNumericSeverity(vulnerability);
          const reference = `https://osv.dev/${encodeURIComponent(vulnerability.id)}`;
          observations.push({
            check: "vulnerabilities",
            rule: vulnerability.id,
            identity: JSON.stringify([
              vulnerability.id,
              ecosystem,
              name,
              dependencyPath,
            ]),
            severity: "error",
            message: `${vulnerability.id} affects ${ecosystem} package ${name}@${version}${fixed === undefined ? "" : `; fixed in ${fixed}`} (${reference})`,
            location: { file: dependencyPath },
            ...(score === undefined
              ? {}
              : { metric: { name: "cvss", value: score } }),
            ...(fixed === undefined
              ? {}
              : { remediation: `Upgrade ${name} to ${fixed} or later.` }),
          });
        }
      }
    }
    return Object.freeze(
      observations.sort((left, right) =>
        compareCodeUnits(left.identity, right.identity),
      ),
    );
  } catch {
    rawReport = "";
    throw new TypeError(INVALID_REPORT);
  }
}
