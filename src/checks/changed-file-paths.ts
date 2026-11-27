import type { CheckRunContext } from "./adapter.js";
import type { SnapshotSide } from "../config/file-policy.js";
import type { RepositoryInspection } from "../inspection/types.js";

const sourceFileSets = new WeakMap<
  RepositoryInspection,
  Map<string, ReadonlySet<string>>
>();

/** Source files of the workspace rooted at relativeRoot; empty when absent. */
export function workspaceSourceFiles(
  inspection: RepositoryInspection,
  relativeRoot: string,
): ReadonlySet<string> {
  let byRoot = sourceFileSets.get(inspection);
  if (byRoot === undefined) {
    byRoot = new Map();
    sourceFileSets.set(inspection, byRoot);
  }
  let files = byRoot.get(relativeRoot);
  if (files === undefined) {
    files = new Set(
      inspection.workspaces.find(
        (workspace) => workspace.relativeRoot === relativeRoot,
      )?.sourceFiles ?? [],
    );
    byRoot.set(relativeRoot, files);
  }
  return files;
}

/** Files needed for file-local analysis, including the old names of renames. */
export function changedFilePaths(
  context: CheckRunContext,
  side: SnapshotSide,
): ReadonlySet<string> {
  const paths = new Set<string>();
  const targetFiles = workspaceSourceFiles(
    context.targetInspection,
    context.target.relativeRoot,
  );
  const baselineFiles = workspaceSourceFiles(
    context.baselineInspection,
    context.target.relativeRoot,
  );
  for (const file of context.changeSet.files.values()) {
    if (side === "baseline") {
      if (
        !baselineFiles.has(file.previousPath ?? file.path) &&
        !targetFiles.has(file.path)
      )
        continue;
    } else if (!targetFiles.has(file.path)) continue;
    if (side === "baseline") {
      if (file.status !== "added") paths.add(file.previousPath ?? file.path);
    } else if (file.status !== "deleted") {
      paths.add(file.path);
    }
  }
  return paths;
}
