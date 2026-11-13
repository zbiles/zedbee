import { recordChangeCategory } from "../diagnostics/scan-performance.js";
import { posix } from "node:path";
import type { ChangeSet } from "../git/change-set.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../inspection/types.js";
import type { InspectionContext } from "./adapter.js";
import { compilerConfigurationInputsForInspection } from "./typescript/configuration-paths.js";

const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/iu;
const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const DATA = /\.jsonc?$/iu;
const ORDINARY_UNRELATED = /\.(?:py|pyi|md|markdown|rst|txt)$/iu;
const DEPENDENCY =
  /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.pnp\.(?:cjs|js|data\.json)|\.npmrc|\.yarnrc(?:\.yml)?)$/iu;
const CONFIGURATION =
  /^(?:tsconfig(?:\.[^.]+)*\.json|jsconfig(?:\.[^.]+)*\.json|(?:zedbee|swarm)\.config\.[^.]+|\.(?:zedbee|swarm)(?:rc)?(?:\.[^.]+)?)$/iu;

export function hasTypeScriptInputs(workspace: WorkspaceInspection): boolean {
  return workspace.sourceFiles.some((path) => TYPESCRIPT_SOURCE.test(path));
}

export type CompilerInputRelevance = Readonly<{
  relevant: boolean;
  reason:
    | "source"
    | "configuration"
    | "dependency"
    | "data"
    | "unknown"
    | "unrelated";
}>;

const changes = new WeakMap<ChangeSet, ReadonlySet<string>>();
function changedPaths(changeSet: ChangeSet): ReadonlySet<string> {
  let paths = changes.get(changeSet);
  if (paths === undefined) {
    const result = new Set<string>();
    for (const file of changeSet.files.values()) {
      result.add(file.path);
      if (file.previousPath !== undefined) result.add(file.previousPath);
    }
    paths = result;
    changes.set(changeSet, paths);
  }
  return paths;
}

const decisions = new WeakMap<
  RepositoryInspection,
  WeakMap<
    RepositoryInspection,
    WeakMap<ChangeSet, Promise<CompilerInputRelevance>>
  >
>();

/** Metadata only. Known source/configuration membership takes precedence over
 * ordinary extensions. A possible input selects every compiler consumer: sibling
 * imports and configuration effects need no incomplete reverse import graph. */
async function resolveRelevance(
  context: InspectionContext,
): Promise<CompilerInputRelevance> {
  const paths = changedPaths(context.changeSet);
  if (paths.size === 0) return { relevant: false, reason: "unrelated" };
  let complete = true;
  for (const inspection of new Set([
    context.baselineInspection,
    context.targetInspection,
  ])) {
    if (inspection.lockfiles.some((path) => paths.has(path)))
      return { relevant: true, reason: "dependency" };
    for (const workspace of inspection.workspaces) {
      if (workspace.sourceFiles.some((path) => paths.has(path)))
        return { relevant: true, reason: "source" };
      if (paths.has(workspace.manifestPath))
        return { relevant: true, reason: "dependency" };
      const inputs = await compilerConfigurationInputsForInspection(
        inspection,
        workspace,
      );
      if ([...inputs.paths].some((path) => paths.has(path)))
        return { relevant: true, reason: "configuration" };
      complete &&= inputs.complete;
    }
  }
  for (const path of paths) {
    const name = posix.basename(path);
    if (SOURCE.test(path)) return { relevant: true, reason: "source" };
    if (DEPENDENCY.test(name)) return { relevant: true, reason: "dependency" };
    if (CONFIGURATION.test(name))
      return { relevant: true, reason: "configuration" };
    if (DATA.test(path)) return { relevant: true, reason: "data" };
    if (name.toLowerCase() !== ".gitignore" && !ORDINARY_UNRELATED.test(path))
      return { relevant: true, reason: "unknown" };
  }
  return complete
    ? { relevant: false, reason: "unrelated" }
    : { relevant: true, reason: "unknown" };
}

export function compilerInputRelevance(
  context: InspectionContext,
  _workspace: WorkspaceInspection,
): Promise<CompilerInputRelevance> {
  let targets = decisions.get(context.baselineInspection);
  if (targets === undefined) {
    targets = new WeakMap();
    decisions.set(context.baselineInspection, targets);
  }
  let scans = targets.get(context.targetInspection);
  if (scans === undefined) {
    scans = new WeakMap();
    targets.set(context.targetInspection, scans);
  }
  let decision = scans.get(context.changeSet);
  if (decision === undefined) {
    decision = resolveRelevance(context);
    scans.set(context.changeSet, decision);
  }
  void decision
    .then((value) => {
      recordChangeCategory(value.reason);
    })
    .catch(() => {});
  return decision;
}
