import { memoizeCompilerDecision } from "./compiler-decision-cache.js";
import {
  COMPILER_SOURCE,
  COMPILER_DEPENDENCY,
  COMPILER_CONFIGURATION,
  COMPILER_ORDINARY,
  changedCompilerPaths,
} from "./compiler-paths.js";
import {
  classifyCompilerChanges,
  compilerPolicyInputPaths,
} from "./compiler-change-inputs.js";
import { recordChangeCategory } from "../diagnostics/scan-performance.js";
import { proveCompilerWorkspaceIndependence } from "./typescript/compiler-scope-graph.js";
import { posix } from "node:path";
import type { WorkspaceInspection } from "../inspection/types.js";
import type { InspectionContext } from "./adapter.js";
import { compilerConfigurationInputsForInspection } from "./typescript/configuration-paths.js";

const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/iu;
const DATA = /\.jsonc?$/iu;

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
    | "unrelated"
    | "independent";
}>;

const scopedDecisions = new WeakMap<
  Promise<CompilerInputRelevance>,
  WeakMap<WorkspaceInspection, Promise<CompilerInputRelevance>>
>();

/** Metadata only. Known source/configuration membership takes precedence over
 * ordinary extensions. A possible input selects every compiler consumer: sibling
 * imports and configuration effects need no incomplete reverse import graph. */
async function resolveRelevance(
  context: InspectionContext,
): Promise<CompilerInputRelevance> {
  const paths = changedCompilerPaths(context.changeSet);
  if (paths.size === 0) return { relevant: false, reason: "unrelated" };
  if ([...compilerPolicyInputPaths(context)].some((path) => paths.has(path)))
    return { relevant: true, reason: "configuration" };
  let complete = true;
  for (const inspection of new Set([
    context.baselineInspection,
    context.targetInspection,
  ])) {
    context.signal?.throwIfAborted();
    if (inspection.workspaces.length > 32)
      return { relevant: true, reason: "unknown" };
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
        context.signal,
      );
      if ([...inputs.paths].some((path) => paths.has(path)))
        return { relevant: true, reason: "configuration" };
      complete &&= inputs.complete;
      if (!complete) return { relevant: true, reason: "unknown" };
    }
  }
  for (const path of paths) {
    const name = posix.basename(path);
    if (COMPILER_SOURCE.test(path)) return { relevant: true, reason: "source" };
    if (COMPILER_DEPENDENCY.test(name))
      return { relevant: true, reason: "dependency" };
    if (COMPILER_CONFIGURATION.test(name))
      return { relevant: true, reason: "configuration" };
    if (DATA.test(path)) return { relevant: true, reason: "data" };
    if (name.toLowerCase() !== ".gitignore" && !COMPILER_ORDINARY.test(path))
      return { relevant: true, reason: "unknown" };
  }
  return complete
    ? { relevant: false, reason: "unrelated" }
    : { relevant: true, reason: "unknown" };
}

const memoizedRelevance = memoizeCompilerDecision(resolveRelevance);

export function compilerInputRelevance(
  context: InspectionContext,
  workspace: WorkspaceInspection,
): Promise<CompilerInputRelevance> {
  if (context.signal?.aborted) return Promise.reject(context.signal.reason);
  const decision = memoizedRelevance(context);
  void decision
    .then((value) => {
      recordChangeCategory(value.reason);
    })
    .catch(() => {});
  let scoped = scopedDecisions.get(decision);
  if (scoped === undefined) {
    scoped = new WeakMap();
    scopedDecisions.set(decision, scoped);
  }
  const previous = scoped.get(workspace);
  if (
    previous !== undefined &&
    ![...changedCompilerPaths(context.changeSet)].some(
      (path) =>
        COMPILER_SOURCE.test(path) ||
        COMPILER_DEPENDENCY.test(posix.basename(path)),
    )
  )
    return previous;
  if (previous !== undefined)
    return previous.then(async (result) => {
      if (result.reason === "independent") {
        if (
          !(await proveCompilerWorkspaceIndependence(context, workspace))
            .independent
        )
          return await decision!;
      }
      return result;
    });
  const narrowed = decision.then(
    async (result): Promise<CompilerInputRelevance> => {
      if (!result.relevant || !["source", "dependency"].includes(result.reason))
        return result;
      const classification = await classifyCompilerChanges(context);
      if (!classification.complete || classification.requiresBroadComparison)
        return result;
      const paths = [
        ...classification.sourcePaths,
        ...classification.localNpmInputs,
      ];
      const prefix =
        workspace.relativeRoot === "." ? "" : `${workspace.relativeRoot}/`;
      if (paths.some((path) => path.startsWith(prefix))) return result;
      if (
        !(await proveCompilerWorkspaceIndependence(context, workspace))
          .independent
      )
        return result;
      return { relevant: false, reason: "independent" };
    },
  );
  scoped.set(workspace, narrowed);
  void narrowed.catch(() => scoped!.delete(workspace));
  return narrowed;
}
