import { createHash } from "node:crypto";
import { diffLines } from "diff";
import type { Observation, SourceLocation } from "../../core/types.js";
import type { ChangeSet } from "../../git/change-set.js";

export interface TypescriptSnapshotObservations {
  readonly observations: readonly Observation[];
  readonly files: Readonly<Record<string, string>>;
}

function comparisonIdentity(
  observation: Observation,
  location = observation.location,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        observation.rule,
        location?.file,
        location?.startLine,
        location?.startColumn,
        location?.endLine,
        location?.endColumn,
        observation.message,
      ]),
    )
    .digest("hex");
}

/** Pair existing diagnostics across unchanged source spans and Git file renames. */
export function pairTypescriptObservations(
  baseline: TypescriptSnapshotObservations,
  target: TypescriptSnapshotObservations,
  changeSet: ChangeSet,
): {
  readonly baselineObservations: readonly Observation[];
  readonly targetObservations: readonly Observation[];
} {
  const renamedPaths = new Map<string, string>();
  for (const file of changeSet.files.values()) {
    if (file.status === "renamed" && file.previousPath !== undefined)
      renamedPaths.set(file.previousPath, file.path);
  }
  const lineMaps = new Map<
    string,
    readonly {
      baselineStart: number;
      targetStart: number;
      count: number;
    }[]
  >();
  const targetLocation = (location: SourceLocation): SourceLocation => {
    const targetPath = renamedPaths.get(location.file) ?? location.file;
    const unchangedPosition = { ...location, file: targetPath };
    const before = baseline.files[location.file];
    const after = target.files[targetPath];
    if (before === after) return unchangedPosition;
    if (
      before === undefined ||
      after === undefined ||
      location.startLine === undefined
    )
      return unchangedPosition;
    let lines = lineMaps.get(location.file);
    if (lines === undefined) {
      const components = diffLines(before, after, { timeout: 2_000 });
      if (components === undefined)
        throw new Error("TypeScript diagnostic comparison timed out.");
      const mapped: {
        baselineStart: number;
        targetStart: number;
        count: number;
      }[] = [];
      let baselineLine = 1;
      let targetLine = 1;
      for (const component of components) {
        const count = component.count ?? 0;
        if (!component.added && !component.removed) {
          mapped.push({
            baselineStart: baselineLine,
            targetStart: targetLine,
            count,
          });
        }
        if (!component.added) baselineLine += count;
        if (!component.removed) targetLine += count;
      }
      lines = mapped;
      lineMaps.set(location.file, lines);
    }
    const oldEnd = location.endLine ?? location.startLine;
    // Every line in a multiline diagnostic must still belong to the same unchanged span.
    const span = lines.find(
      (range) =>
        range.baselineStart <= location.startLine! &&
        oldEnd < range.baselineStart + range.count,
    );
    // Harmless edits may change a whole line while leaving the diagnostic itself identical.
    if (span === undefined) return unchangedPosition;
    const offset = span.targetStart - span.baselineStart;
    return {
      ...unchangedPosition,
      startLine: location.startLine + offset,
      ...(location.endLine === undefined ? {} : { endLine: oldEnd + offset }),
    };
  };
  return {
    baselineObservations: baseline.observations.map((observation) => {
      const location =
        observation.location === undefined
          ? undefined
          : targetLocation(observation.location);
      return {
        ...observation,
        comparisonIdentity: comparisonIdentity(observation, location),
      };
    }),
    targetObservations: target.observations.map((observation) => ({
      ...observation,
      comparisonIdentity: comparisonIdentity(observation),
    })),
  };
}
