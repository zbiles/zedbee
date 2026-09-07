import type { CheckId } from "../config/schema.js";
import type {
  CheckApplicability,
  CheckTarget,
  ExecutionClass,
  InspectionContext,
} from "./adapter.js";
import type { WorkspaceInspection } from "../inspection/types.js";
import { compareCodeUnits } from "../core/compare.js";
import { isSupportedPrettierPath } from "./prettier/supported-path.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const TYPESCRIPT = /\.(?:ts|tsx|mts|cts)$/iu;
const ROOT: CheckTarget = Object.freeze({
  id: ".",
  kind: "repository",
  relativeRoot: ".",
});
export function executionClassFor(checkId: CheckId): ExecutionClass {
  if (checkId === "vulnerabilities") return "network";
  return [
    "lint",
    "types",
    "secrets",
    "duplication",
    "dependencyArchitecture",
    "deadCode",
  ].includes(checkId)
    ? "project-analysis"
    : "lightweight";
}
const targetFor = (workspace: WorkspaceInspection): CheckTarget => ({
  id: workspace.relativeRoot,
  kind: "workspace",
  relativeRoot: workspace.relativeRoot,
});

export function hasDependencyStateDelta(context: InspectionContext): boolean {
  const dependencyPaths = new Set([
    ...context.baselineInspection.lockfiles,
    ...context.targetInspection.lockfiles,
  ]);
  return [...context.changeSet.files.values()].some((file) =>
    dependencyPaths.has(file.path),
  );
}

/** Applicability is metadata only; it never opens an analyzer or executes config. */
export async function inspectManagedCheck(
  checkId: CheckId,
  context: InspectionContext,
): Promise<CheckApplicability> {
  const files = [...context.changeSet.files.values()];
  const changed = new Set(
    files.filter((file) => file.status !== "deleted").map((file) => file.path),
  );
  const always = context.config.checks[checkId].when === "always";
  const applicable = (targets: readonly CheckTarget[]): CheckApplicability => ({
    applies: true,
    executionClass: executionClassFor(checkId),
    requiresBaseline: checkId !== "formatting",
    targets,
  });
  if (checkId === "formatting")
    return always ||
      files.some(
        (file) =>
          file.status !== "deleted" && isSupportedPrettierPath(file.path),
      )
      ? applicable([ROOT])
      : { applies: false, reason: "No supported staged files" };
  if (checkId === "secrets")
    return changed.size > 0
      ? applicable([ROOT])
      : { applies: false, reason: "No changed target files to scan" };
  if (checkId === "vulnerabilities") {
    if (!always && !hasDependencyStateDelta(context))
      return { applies: false, reason: "No staged dependency state changes" };
    return {
      applies: true,
      executionClass: "network",
      requiresBaseline: true,
      targets: [ROOT],
      networkDisclosure: {
        services: ["api.osv.dev"],
        metadata: ["package names", "exact versions", "ecosystem identifiers"],
      },
    };
  }
  let workspaces = context.targetInspection.workspaces;
  if (checkId === "dependencyArchitecture" || checkId === "deadCode") {
    const all = [...context.baselineInspection.workspaces, ...workspaces];
    const candidates = new Map(
      all.map((workspace) => [workspace.relativeRoot, workspace]),
    );
    const changedIncludingDeleted = new Set(files.map((file) => file.path));
    workspaces = [...candidates.values()]
      .filter((workspace) =>
        always
          ? workspace.sourceFiles.some((path) => SOURCE.test(path))
          : all
              .filter((side) => side.relativeRoot === workspace.relativeRoot)
              .some(
                (side) =>
                  changedIncludingDeleted.has(side.manifestPath) ||
                  (checkId === "dependencyArchitecture" &&
                    side.tsconfigPaths.some((path) =>
                      changedIncludingDeleted.has(path),
                    )) ||
                  side.sourceFiles.some(
                    (path) =>
                      (checkId === "deadCode" || SOURCE.test(path)) &&
                      changedIncludingDeleted.has(path),
                  ),
              ),
      )
      .sort((a, b) => compareCodeUnits(a.relativeRoot, b.relativeRoot));
  } else if (checkId === "lint")
    workspaces = workspaces.filter(
      (workspace) =>
        workspace.sourceFiles.length > 0 &&
        (always || workspace.sourceFiles.some((path) => changed.has(path))),
    );
  else if (checkId === "types")
    workspaces = workspaces.filter(
      (workspace) =>
        workspace.sourceFiles.some((path) => TYPESCRIPT.test(path)) &&
        (always ||
          workspace.sourceFiles.some(
            (path) => TYPESCRIPT.test(path) && changed.has(path),
          )),
    );
  else {
    if (checkId === "reactCorrectness" || checkId === "reactAccessibility") {
      const environments =
        checkId === "reactAccessibility"
          ? ["react-dom", "next", "remix"]
          : ["react", "react-dom", "ink", "next", "remix"];
      workspaces = workspaces.filter((workspace) =>
        workspace.environments.some((environment) =>
          environments.includes(environment),
        ),
      );
      if (workspaces.length === 0)
        return {
          applies: false,
          reason:
            checkId === "reactAccessibility"
              ? "No browser DOM renderer detected"
              : "No React renderer detected",
        };
    }
    workspaces = workspaces.filter((workspace) =>
      workspace.sourceFiles.some(
        (path) => SOURCE.test(path) && (always || changed.has(path)),
      ),
    );
  }
  return workspaces.length > 0
    ? applicable(workspaces.map(targetFor))
    : {
        applies: false,
        reason:
          checkId === "types"
            ? "No supported staged TypeScript source files"
            : checkId === "deadCode"
              ? "No supported staged project files"
              : "No supported staged source files",
      };
}
