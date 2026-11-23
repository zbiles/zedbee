import { memoizeCompilerDecision } from "./compiler-decision-cache.js";
import {
  COMPILER_SOURCE,
  COMPILER_DEPENDENCY,
  COMPILER_CONFIGURATION,
  isOrdinaryCompilerPath,
  changedCompilerPaths,
} from "./compiler-paths.js";
import { posix, relative, resolve, sep, isAbsolute } from "node:path";
import type { InspectionContext } from "./adapter.js";
import { compilerConfigurationInputsForInspection } from "./typescript/configuration-paths.js";
export function compilerPolicyInputPaths(
  context: InspectionContext,
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const policy of [context.config, context.filePolicyConfig]) {
    if (policy?.configPath === undefined) continue;
    const path = relative(
      context.repositoryRoot,
      resolve(context.repositoryRoot, policy.configPath),
    );
    if (
      path !== "" &&
      !isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith(`..${sep}`)
    )
      paths.add(path.split(sep).join("/"));
  }
  return paths;
}
export interface CompilerChangeClassification {
  readonly sourcePaths: ReadonlySet<string>;
  readonly unclassifiedPaths: ReadonlySet<string>;
  readonly localNpmInputs: ReadonlySet<string>;
  readonly separateNpmRoots: ReadonlySet<string>;
  readonly requiresBroadComparison: boolean;
  readonly complete: boolean;
}
/** Both rename endpoints and both captured inventories precede extension hints. */
async function acquireCompilerChanges(
  context: InspectionContext,
): Promise<CompilerChangeClassification> {
  context.signal?.throwIfAborted();
  const paths = changedCompilerPaths(context.changeSet);
  const sourcePaths = new Set<string>();
  const unclassifiedPaths = new Set<string>();
  const localNpmInputs = new Set<string>();
  const inspections = [context.baselineInspection, context.targetInspection];
  if (inspections.some((inspection) => inspection.workspaces.length > 32)) {
    return {
      sourcePaths,
      unclassifiedPaths,
      localNpmInputs,
      separateNpmRoots: new Set(),
      complete: false,
      requiresBroadComparison: true,
    };
  }
  const separateNpmRoots = new Set(
    context.targetInspection.workspaces
      .map((workspace) => workspace.relativeRoot)
      .filter(
        (root) =>
          root !== "." &&
          !root.includes("/") &&
          inspections.every(
            (inspection) =>
              !inspection.workspaces.some(
                (workspace) => workspace.relativeRoot === ".",
              ) &&
              !inspection.lockfiles.some((path) => !path.includes("/")) &&
              inspection.lockfiles.includes(`${root}/package-lock.json`) &&
              inspection.workspaces.some(
                (workspace) =>
                  workspace.relativeRoot === root &&
                  workspace.dependencyDeclarations.every(
                    ({ specifier }) =>
                      !/^(?:workspace:|file:|link:|[./\\])/iu.test(specifier),
                  ),
              ),
          ),
      ),
  );
  const configurations = new Set<string>(compilerPolicyInputPaths(context));
  const dependencies = new Set<string>();
  let complete = true;
  for (const inspection of new Set([
    context.baselineInspection,
    context.targetInspection,
  ])) {
    for (const path of inspection.lockfiles) dependencies.add(path);
    for (const workspace of inspection.workspaces) {
      context.signal?.throwIfAborted();
      for (const path of workspace.sourceFiles)
        if (paths.has(path)) sourcePaths.add(path);
      dependencies.add(workspace.manifestPath);
      const inputs = await compilerConfigurationInputsForInspection(
        inspection,
        workspace,
        context.signal,
      );
      context.signal?.throwIfAborted();
      complete &&= inputs.complete;
      if (!complete)
        return {
          sourcePaths,
          unclassifiedPaths,
          localNpmInputs,
          separateNpmRoots,
          complete: false,
          requiresBroadComparison: true,
        };
      for (const path of inputs.paths) configurations.add(path);
    }
  }
  let requiresBroadComparison = !complete;
  for (const path of paths) {
    const name = posix.basename(path);
    if (COMPILER_SOURCE.test(path)) sourcePaths.add(path);
    if (
      !configurations.has(path) &&
      (name === "package.json" || name === "package-lock.json") &&
      separateNpmRoots.has(posix.dirname(path))
    ) {
      localNpmInputs.add(path);
    } else if (
      configurations.has(path) ||
      dependencies.has(path) ||
      COMPILER_DEPENDENCY.test(name) ||
      COMPILER_CONFIGURATION.test(name) ||
      /\.d\.[cm]?ts$/iu.test(path)
    )
      requiresBroadComparison = true;
    else if (!sourcePaths.has(path) && !isOrdinaryCompilerPath(path))
      unclassifiedPaths.add(path);
  }
  return {
    sourcePaths,
    unclassifiedPaths,
    localNpmInputs,
    separateNpmRoots,
    requiresBroadComparison,
    complete,
  };
}

export const classifyCompilerChanges = memoizeCompilerDecision(
  acquireCompilerChanges,
);
