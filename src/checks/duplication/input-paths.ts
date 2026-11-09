import { compareCodeUnits } from "../../core/compare.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import type { InspectionContext } from "../adapter.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const inputs = new WeakMap<
  RepositoryInspection,
  WeakMap<WorkspaceInspection, readonly string[]>
>();

/** jscpd 5.3.2 receives explicit file arguments. Its Git ignore walker does not
 * filter explicit files (including with root or nested ignore files). Keep this
 * contract shared with execution and pinned against the actual engine in tests.
 * Do not approximate directory-walker ignore rules here.
 */
export async function duplicationInputPaths(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
): Promise<readonly string[]> {
  let workspaces = inputs.get(inspection);
  if (workspaces === undefined) {
    workspaces = new WeakMap();
    inputs.set(inspection, workspaces);
  }
  let paths = workspaces.get(workspace);
  if (paths === undefined) {
    paths = Object.freeze(
      workspace.sourceFiles
        .filter((path) => SOURCE.test(path))
        .sort(compareCodeUnits),
    );
    workspaces.set(workspace, paths);
  }
  return paths;
}

export async function duplicationInputsMayHaveChanged(
  context: InspectionContext,
  relativeRoot: string,
): Promise<boolean> {
  const paths = new Set<string>();
  const sides: (readonly string[])[] = [];
  for (const inspection of [
    context.baselineInspection,
    context.targetInspection,
  ]) {
    const workspace = inspection.workspaces.find(
      (candidate) => candidate.relativeRoot === relativeRoot,
    );
    const side =
      workspace === undefined
        ? []
        : await duplicationInputPaths(inspection, workspace);
    sides.push(side);
    for (const path of side) paths.add(path);
  }
  if (
    sides[0]!.length !== sides[1]!.length ||
    sides[0]!.some((path, index) => path !== sides[1]![index])
  )
    return true;
  return [...context.changeSet.files.values()].some(
    (file) =>
      paths.has(file.path) ||
      (file.previousPath !== undefined && paths.has(file.previousPath)),
  );
}
