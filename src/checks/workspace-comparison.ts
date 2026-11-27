import { posix } from "node:path";
import { changeSetFromMap, type ChangedFile } from "../git/change-set.js";
import { createFilePolicyResolver } from "../config/file-policy.js";
import type { InspectionContext } from "./adapter.js";
import type { RepositoryInspection } from "../inspection/types.js";
import {
  workspaceContainsFile,
  physicalWorkspaceRoot,
  physicalWorkspaceOrder,
} from "../inspection/workspace-owner.js";

const ownerIndexes = new WeakMap<
  RepositoryInspection,
  {
    readonly aliases: boolean;
    readonly physical: readonly import("../inspection/types.js").WorkspaceInspection[];
    readonly lexical: readonly import("../inspection/types.js").WorkspaceInspection[];
  }
>();
function ownerIndex(inspection: RepositoryInspection) {
  let index = ownerIndexes.get(inspection);
  if (index !== undefined) return index;
  const aliases = inspection.workspaces.some(
    (workspace) => workspace.canonicalRelativeRoot !== undefined,
  );
  index = {
    aliases,
    physical: aliases
      ? physicalWorkspaceOrder(inspection.workspaces)
      : inspection.workspaces,
    lexical: aliases
      ? [...inspection.workspaces].sort(
          (a, b) => b.relativeRoot.length - a.relativeRoot.length,
        )
      : inspection.workspaces,
  };
  ownerIndexes.set(inspection, index);
  return index;
}
export function hasWorkspaceAliases(inspection: RepositoryInspection): boolean {
  return ownerIndex(inspection).aliases;
}

function analysisPath(inspection: RepositoryInspection, path: string): string {
  const owner = ownerIndex(inspection).physical.find((w) =>
    workspaceContainsFile(physicalWorkspaceRoot(w), path),
  );
  if (!owner?.canonicalRelativeRoot) return path;
  return posix.join(
    owner.relativeRoot,
    posix.relative(owner.canonicalRelativeRoot, path),
  );
}

export function physicalWorkspacePath(
  inspection: RepositoryInspection,
  path: string,
): string {
  if (!hasWorkspaceAliases(inspection)) return path;
  const owner = ownerIndex(inspection).lexical.find((w) =>
    workspaceContainsFile(w.relativeRoot, path),
  );
  if (!owner?.canonicalRelativeRoot) return path;
  const physical = posix.join(
    owner.canonicalRelativeRoot,
    posix.relative(owner.relativeRoot, path),
  );
  return analysisPath(inspection, physical) === path ? physical : path;
}

function isWorkspaceCheck(checkId: string): boolean {
  return [
    "lint",
    "types",
    "cyclomaticComplexity",
    "readabilityComplexity",
    "structuralSecurity",
    "duplication",
    "dependencyArchitecture",
    "deadCode",
    "reactCorrectness",
    "reactAccessibility",
  ].includes(checkId);
}

/** Project tracked comparison endpoints into the declared workspace spelling
 * used by analyzers and their snapshot inventories. Preserve the actual ranges. */
export function projectWorkspaceComparison<T extends InspectionContext>(
  context: T,
  checkId: string,
): T {
  if (
    !isWorkspaceCheck(checkId) ||
    (!hasWorkspaceAliases(context.baselineInspection) &&
      !hasWorkspaceAliases(context.targetInspection))
  )
    return context;
  const files = new Map<string, ChangedFile>();
  let projected = false;
  for (const file of context.changeSet.files.values()) {
    const before = analysisPath(
      context.baselineInspection,
      file.previousPath ?? file.path,
    );
    const after = analysisPath(context.targetInspection, file.path);
    const path = file.status === "deleted" ? before : after;
    const rename =
      file.status === "renamed" ||
      (file.status === "modified" && before !== after);
    const changed =
      path !== file.path || (rename && before !== file.previousPath);
    projected ||= changed;
    if (files.has(path))
      throw new TypeError("Ambiguous changed workspace path");
    files.set(
      path,
      changed
        ? {
            path,
            status: rename ? "renamed" : file.status,
            ...(rename ? { previousPath: before } : {}),
            addedRanges: file.addedRanges,
          }
        : file,
    );
  }
  const changeSet = projected
    ? changeSetFromMap(files, context.changeSet.isEmpty)
    : context.changeSet;
  return {
    ...context,
    changeSet,
    ...("policyForFile" in context
      ? {
          policyForFile: workspaceComparisonFilePolicy({
            ...context,
            changeSet,
          }),
        }
      : {}),
  };
}

export function workspaceComparisonFilePolicy(context: InspectionContext) {
  const aliases =
    hasWorkspaceAliases(context.baselineInspection) ||
    hasWorkspaceAliases(context.targetInspection);
  return createFilePolicyResolver(
    context.filePolicyConfig ?? context.config,
    context.changeSet,
    aliases
      ? (path, side) => {
          const target = physicalWorkspacePath(context.targetInspection, path);
          return target !== path
            ? target
            : side === "baseline"
              ? physicalWorkspacePath(context.baselineInspection, path)
              : path;
        }
      : undefined,
  );
}
