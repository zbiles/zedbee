import type { ChangeSet } from "../git/change-set.js";
import type { WorkspaceInspection } from "../inspection/types.js";

const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/iu;

export function hasTypeScriptInputs(workspace: WorkspaceInspection): boolean {
  return workspace.sourceFiles.some((path) => TYPESCRIPT_SOURCE.test(path));
}

/** Configuration, JSON and sibling sources can affect an unchanged consumer.
 * Until a complete reverse compiler-input graph exists, every nonempty delta
 * must be considered by each TypeScript workspace.
 */
export function compilerInputsMayHaveChanged(
  workspace: WorkspaceInspection,
  changeSet: ChangeSet,
): boolean {
  return hasTypeScriptInputs(workspace) && !changeSet.isEmpty;
}
