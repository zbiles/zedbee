import { posix, relative, resolve, sep, isAbsolute } from "node:path";
import type { InspectionContext } from "./adapter.js";
import { compilerConfigurationInputsForInspection } from "./typescript/configuration-paths.js";
export const COMPILER_SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
export const COMPILER_DEPENDENCY =
  /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.pnp\.(?:cjs|js|data\.json)|\.npmrc|\.yarnrc(?:\.yml)?)$/iu;
export const COMPILER_CONFIGURATION =
  /^(?:tsconfig(?:\.[^.]+)*\.json|jsconfig(?:\.[^.]+)*\.json|(?:zedbee|swarm)\.config\.[^.]+|\.(?:zedbee|swarm)(?:rc)?(?:\.[^.]+)?)$/iu;
const ORDINARY = /\.(?:py|pyi|md|markdown|rst|txt)$/iu;
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
  readonly requiresBroadComparison: boolean;
  readonly complete: boolean;
}
/** Both rename endpoints and both captured inventories precede extension hints. */
async function acquireCompilerChanges(
  context: InspectionContext,
): Promise<CompilerChangeClassification> {
  context.signal?.throwIfAborted();
  const paths = new Set(
    [...context.changeSet.files.values()].flatMap((f) =>
      f.previousPath === undefined ? [f.path] : [f.path, f.previousPath],
    ),
  );
  const sourcePaths = new Set<string>();
  const configurations = new Set<string>(compilerPolicyInputPaths(context));
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
      context.signal?.throwIfAborted();
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

const classificationOwners = new WeakMap<
  object,
  WeakMap<object, typeof classifications>
>();
const classificationPolicies = new WeakMap<object, typeof classifications>();
const classifications = new WeakMap<
  object,
  WeakMap<object, WeakMap<object, Promise<CompilerChangeClassification>>>
>();
export function classifyCompilerChanges(
  context: InspectionContext,
): Promise<CompilerChangeClassification> {
  if (context.signal?.aborted) return Promise.reject(context.signal.reason);
  let policies = classificationPolicies;
  if (context.signal !== undefined) {
    policies = classificationOwners.get(context.signal) ?? new WeakMap();
    classificationOwners.set(context.signal, policies);
  }
  const policy = context.filePolicyConfig ?? context.config;
  const cache = policies.get(policy) ?? new WeakMap();
  policies.set(policy, cache);
  let targets = cache.get(context.baselineInspection);
  if (targets === undefined) {
    targets = new WeakMap();
    cache.set(context.baselineInspection, targets);
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
