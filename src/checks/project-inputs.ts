import type { CheckTarget, InspectionContext } from "./adapter.js";
import type { ChangeSet } from "../git/change-set.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../inspection/types.js";
import { createCompilerConfigurationResolver } from "./typescript/configuration-paths.js";

// Inspection objects are immutable and scan-scoped. Avoid process-wide caches
// keyed by directory paths, which can outlive their selected snapshot.
const configurationResolvers = new WeakMap<
  RepositoryInspection,
  ReturnType<typeof createCompilerConfigurationResolver>
>();

function configurationResolver(inspection: RepositoryInspection) {
  let resolver = configurationResolvers.get(inspection);
  if (resolver === undefined) {
    resolver = createCompilerConfigurationResolver(inspection.snapshotRoot);
    configurationResolvers.set(inspection, resolver);
  }
  return resolver;
}

// Weak keys bind preparation to the immutable scan inputs, including when the
// dispatcher creates new context objects for applicability and collection.
const changes = new WeakMap<
  ChangeSet,
  { changed: ReadonlySet<string>; deleted: ReadonlySet<string> }
>();
const workspaceIndexes = new WeakMap<
  RepositoryInspection,
  ReadonlyMap<string, WorkspaceInspection>
>();

function changeIndex(changeSet: ChangeSet) {
  let index = changes.get(changeSet);
  if (index === undefined) {
    const changed = new Set<string>();
    const deleted = new Set<string>();
    for (const file of changeSet.files.values()) {
      const path = file.path;
      changed.add(path);
      if (file.previousPath !== undefined) changed.add(file.previousPath);
      if (file.status === "deleted") deleted.add(path);
    }
    index = { changed, deleted };
    changes.set(changeSet, index);
  }
  return index;
}

function workspaceIndex(inspection: RepositoryInspection) {
  let index = workspaceIndexes.get(inspection);
  if (index === undefined) {
    index = new Map(
      inspection.workspaces.map((workspace) => [
        workspace.relativeRoot,
        workspace,
      ]),
    );
    workspaceIndexes.set(inspection, index);
  }
  return index;
}

/** Scope graph analysis to changed workspace inputs, including contained
 * inherited configurations outside the workspace's own directory.
 */
export async function projectInputsMayHaveChanged(
  context: InspectionContext,
  target: CheckTarget,
  sourceChanges: "all" | "deletions" = "all",
): Promise<boolean> {
  const { changed, deleted } = changeIndex(context.changeSet);
  if (changed.size === 0) return false;
  for (const inspection of [
    context.baselineInspection,
    context.targetInspection,
  ]) {
    const workspace = workspaceIndex(inspection).get(target.relativeRoot);
    if (workspace === undefined) continue;
    const sourcePaths = sourceChanges === "all" ? changed : deleted;
    const changedSource = workspace.sourceFiles.some((path) =>
      sourcePaths.has(path),
    );
    if (
      changedSource ||
      [workspace.manifestPath, ...workspace.tsconfigPaths].some((path) =>
        changed.has(path),
      )
    )
      return true;
    if (
      [...(await configurationResolver(inspection)(workspace))].some((path) =>
        changed.has(path),
      )
    )
      return true;
  }
  return false;
}
