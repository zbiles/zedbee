import { compareCodeUnits } from "../core/compare.js";

/** A null export is an intentional block, not an invalid path. */
export function packageExportTargets(
  value: unknown,
  depth = 0,
): readonly (string | null)[] {
  if (depth > 8) throw new TypeError("Workspace exports are too deeply nested");
  if (typeof value === "string" || value === null) return [value];
  if (Array.isArray(value)) {
    return value.flatMap((candidate) =>
      packageExportTargets(candidate, depth + 1),
    );
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort(compareCodeUnits)
      .flatMap((key) => packageExportTargets(record[key], depth + 1));
  }
  throw new TypeError("Invalid workspace exports");
}

/** Select condition branches in declaration order, matching the graph
 * resolver's configured condition set. Arrays retain ordered fallbacks. */
export function packageExportTargetsForConditions(
  value: unknown,
  conditions: ReadonlySet<string>,
  depth = 0,
): readonly (string | null)[] {
  if (depth > 8) throw new TypeError("Workspace exports are too deeply nested");
  if (typeof value === "string" || value === null) return [value];
  if (Array.isArray(value))
    return value.flatMap((candidate) =>
      packageExportTargetsForConditions(candidate, conditions, depth + 1),
    );
  if (typeof value === "object") {
    for (const [condition, candidate] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (condition !== "default" && !conditions.has(condition)) continue;
      const selected = packageExportTargetsForConditions(
        candidate,
        conditions,
        depth + 1,
      );
      if (selected.length > 0) return selected;
    }
    return [];
  }
  throw new TypeError("Invalid workspace exports");
}
