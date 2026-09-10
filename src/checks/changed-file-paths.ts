import type { CheckRunContext } from "./adapter.js";
import type { SnapshotSide } from "../config/file-policy.js";

/** Files needed for file-local analysis, including the old names of renames. */
export function changedFilePaths(
  context: CheckRunContext,
  side: SnapshotSide,
): ReadonlySet<string> {
  const paths = new Set<string>();
  const targetFiles = new Set(
    context.targetInspection.workspaces.find(
      ({ relativeRoot }) => relativeRoot === context.target.relativeRoot,
    )?.sourceFiles ?? [],
  );
  for (const file of context.changeSet.files.values()) {
    if (!targetFiles.has(file.path)) continue;
    if (side === "baseline") {
      if (file.status !== "added") paths.add(file.previousPath ?? file.path);
    } else if (file.status !== "deleted") {
      paths.add(file.path);
    }
  }
  return paths;
}
