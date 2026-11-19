import { posix } from "node:path";
import type { InspectionContext } from "./adapter.js";
import { compilerConfigurationInputsForInspection } from "./typescript/configuration-paths.js";
export const COMPILER_SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
export const COMPILER_DEPENDENCY =
  /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.pnp\.(?:cjs|js|data\.json)|\.npmrc|\.yarnrc(?:\.yml)?)$/iu;
export const COMPILER_CONFIGURATION =
  /^(?:tsconfig(?:\.[^.]+)*\.json|jsconfig(?:\.[^.]+)*\.json|(?:zedbee|swarm)\.config\.[^.]+|\.(?:zedbee|swarm)(?:rc)?(?:\.[^.]+)?)$/iu;
const ORDINARY = /\.(?:py|pyi|md|markdown|rst|txt)$/iu;
export interface CompilerChangeClassification {
  readonly sourcePaths: ReadonlySet<string>;
  readonly requiresBroadComparison: boolean;
  readonly complete: boolean;
}
/** Both rename endpoints and both captured inventories precede extension hints. */
async function acquireCompilerChanges(
  context: InspectionContext,
): Promise<CompilerChangeClassification> {
  const paths = new Set(
    [...context.changeSet.files.values()].flatMap((f) =>
      f.previousPath === undefined ? [f.path] : [f.path, f.previousPath],
    ),
  );
  const sourcePaths = new Set<string>();
  const configurations = new Set<string>();
  const dependencies = new Set<string>();
  let complete = true;
  for (const inspection of new Set([
    context.baselineInspection,
    context.targetInspection,
  ])) {
    for (const path of inspection.lockfiles) dependencies.add(path);
    for (const workspace of inspection.workspaces) {
      for (const path of workspace.sourceFiles)
        if (paths.has(path)) sourcePaths.add(path);
      dependencies.add(workspace.manifestPath);
      const inputs = await compilerConfigurationInputsForInspection(
        inspection,
        workspace,
      );
      complete &&= inputs.complete;
      for (const path of inputs.paths) configurations.add(path);
    }
  }
  let requiresBroadComparison = !complete;
  for (const path of paths) {
    const name = posix.basename(path);
    if (COMPILER_SOURCE.test(path)) sourcePaths.add(path);
    if (
      configurations.has(path) ||
      dependencies.has(path) ||
      COMPILER_DEPENDENCY.test(name) ||
      COMPILER_CONFIGURATION.test(name) ||
      /\.d\.[cm]?ts$/iu.test(path)
    )
      requiresBroadComparison = true;
    else if (
      !sourcePaths.has(path) &&
      name.toLowerCase() !== ".gitignore" &&
      !ORDINARY.test(path)
    )
      requiresBroadComparison = true;
  }
  return { sourcePaths, requiresBroadComparison, complete };
}

const classifications = new WeakMap<
  object,
  WeakMap<object, WeakMap<object, Promise<CompilerChangeClassification>>>
>();
export function classifyCompilerChanges(
  context: InspectionContext,
): Promise<CompilerChangeClassification> {
  let targets = classifications.get(context.baselineInspection);
  if (targets === undefined) {
    targets = new WeakMap();
    classifications.set(context.baselineInspection, targets);
  }
  let scans = targets.get(context.targetInspection);
  if (scans === undefined) {
    scans = new WeakMap();
    targets.set(context.targetInspection, scans);
  }
  let pending = scans.get(context.changeSet);
  if (pending === undefined) {
    pending = acquireCompilerChanges(context);
    scans.set(context.changeSet, pending);
    void pending.catch(() => {
      scans!.delete(context.changeSet);
    });
  }
  return pending;
}
