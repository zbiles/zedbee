import type { CheckTarget, InspectionContext } from "./adapter.js";
import { compilerConfigurationPaths } from "./typescript/configuration-paths.js";

/** Scope graph analysis to changed workspace inputs, including contained
 * inherited configurations outside the workspace's own directory.
 */
export async function projectInputsMayHaveChanged(
  context: InspectionContext,
  target: CheckTarget,
  sourceChanges: "all" | "deletions" = "all",
): Promise<boolean> {
  const changed = new Set(
    [...context.changeSet.files.values()].flatMap((file) =>
      file.previousPath === undefined
        ? [file.path]
        : [file.path, file.previousPath],
    ),
  );
  if (changed.size === 0) return false;
  for (const inspection of [
    context.baselineInspection,
    context.targetInspection,
  ]) {
    const workspace = inspection.workspaces.find(
      ({ relativeRoot }) => relativeRoot === target.relativeRoot,
    );
    if (workspace === undefined) continue;
    const changedSource =
      sourceChanges === "all"
        ? workspace.sourceFiles.some((path) => changed.has(path))
        : [...context.changeSet.files.values()].some(
            (file) =>
              file.status === "deleted" &&
              workspace.sourceFiles.includes(file.path),
          );
    if (
      changedSource ||
      [workspace.manifestPath, ...workspace.tsconfigPaths].some((path) =>
        changed.has(path),
      )
    )
      return true;
    if (
      [
        ...(await compilerConfigurationPaths(
          inspection.snapshotRoot,
          workspace,
        )),
      ].some((path) => changed.has(path))
    )
      return true;
  }
  return false;
}
