import { deadCodePolicyPath } from "./dead-code/entry-configuration.js";
import {
  entryOwner,
  viteInputPathsForInspection,
} from "./dead-code/vite-entrypoints.js";
import type { CheckTarget, InspectionContext } from "./adapter.js";
import type { ChangeSet } from "../git/change-set.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../inspection/types.js";
import { compilerConfigurationInputsForInspection } from "./typescript/configuration-paths.js";

// Weak keys bind preparation to the immutable scan inputs, including when the
// dispatcher creates new context objects for applicability and collection.
const changes = new WeakMap<
  ChangeSet,
  { changed: ReadonlySet<string>; deleted: ReadonlySet<string> }
>();
const removedWorkspaceInputs = new WeakMap<
  ChangeSet,
  WeakMap<RepositoryInspection, boolean>
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
      if (file.status === "renamed" && file.previousPath !== undefined)
        deleted.add(file.previousPath);
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

function hasRemovedWorkspaceInputs(
  context: InspectionContext,
  deleted: ReadonlySet<string>,
): boolean {
  if (deleted.size === 0) return false;
  let byInspection = removedWorkspaceInputs.get(context.changeSet);
  if (!byInspection) {
    byInspection = new WeakMap();
    removedWorkspaceInputs.set(context.changeSet, byInspection);
  }
  let removed = byInspection.get(context.baselineInspection);
  if (removed === undefined) {
    removed = context.baselineInspection.workspaces.some(
      (workspace) =>
        deleted.has(workspace.manifestPath) ||
        workspace.sourceFiles.some((path) => deleted.has(path)),
    );
    byInspection.set(context.baselineInspection, removed);
  }
  return removed;
}

/** Scope graph analysis to changed workspace inputs, including contained
 * inherited configurations outside the workspace's own directory.
 */
export async function projectInputsMayHaveChanged(
  context: InspectionContext,
  target: CheckTarget,
  sourceChanges: "all" | "deletions" = "all",
  entryInputs?: "deadCode",
): Promise<boolean> {
  const { changed, deleted } = changeIndex(context.changeSet);
  if (changed.size === 0) return false;
  // A disappearing source/package can invalidate imports or entrypoint usage
  // in another surviving project, even if that consumer itself did not change.
  const targetWorkspace = workspaceIndex(context.targetInspection).get(
    target.relativeRoot,
  );
  if (
    targetWorkspace?.sourceFiles.length &&
    hasRemovedWorkspaceInputs(context, deleted)
  )
    return true;
  for (const inspection of [
    context.baselineInspection,
    context.targetInspection,
  ]) {
    const workspace = workspaceIndex(inspection).get(target.relativeRoot);
    if (workspace === undefined) continue;
    if (entryInputs === "deadCode") {
      if (
        changed.has(deadCodePolicyPath(context.repositoryRoot, context.config))
      )
        return true;
      const explicit = (
        context.config.checks.deadCode.entryPoints ?? []
      ).filter(
        (path) =>
          entryOwner(inspection, path)?.relativeRoot === target.relativeRoot,
      );
      if (
        (
          await viteInputPathsForInspection(inspection, workspace, explicit)
        ).some((path) => changed.has(path))
      )
        return true;
    }
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
    const configuration = await compilerConfigurationInputsForInspection(
      inspection,
      workspace,
      context.signal,
    );
    if (
      configuration.limited === true ||
      [...configuration.paths].some((path) => changed.has(path))
    )
      return true;
  }
  return false;
}
