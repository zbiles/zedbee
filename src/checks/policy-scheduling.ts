import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import type { FilePolicyResolver } from "../config/file-policy.js";
import type { CheckId, ResolvedCheckPolicy } from "../config/schema.js";
import type { ChangeSet } from "../git/change-set.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../inspection/types.js";
import type { CheckTarget } from "./adapter.js";
import { isSupportedPrettierPath } from "./prettier/supported-path.js";

const JAVASCRIPT_SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/iu;

function targetWorkspaces(
  target: CheckTarget,
  inspection: RepositoryInspection,
): readonly WorkspaceInspection[] {
  if (target.kind === "repository") return inspection.workspaces;
  return inspection.workspaces.filter(
    ({ relativeRoot }) => relativeRoot === target.relativeRoot,
  );
}

function workspacePaths(
  checkId: CheckId,
  workspace: WorkspaceInspection,
): readonly string[] {
  switch (checkId) {
    case "types":
      return workspace.sourceFiles.filter((path) =>
        TYPESCRIPT_SOURCE.test(path),
      );
    case "lint":
    case "cyclomaticComplexity":
    case "readabilityComplexity":
    case "structuralSecurity":
    case "reactCorrectness":
    case "reactAccessibility":
      return workspace.sourceFiles.filter((path) =>
        JAVASCRIPT_SOURCE.test(path),
      );
    case "deadCode":
      return [
        workspace.manifestPath,
        ...workspace.sourceFiles.filter((path) => JAVASCRIPT_SOURCE.test(path)),
      ];
    case "dependencyArchitecture":
      return [
        workspace.manifestPath,
        ...workspace.tsconfigPaths,
        ...workspace.sourceFiles.filter((path) => JAVASCRIPT_SOURCE.test(path)),
      ];
    case "vulnerabilities":
      return [workspace.manifestPath];
    case "formatting":
      return [
        workspace.manifestPath,
        ...workspace.sourceFiles,
        ...workspace.tsconfigPaths,
      ].filter(isSupportedPrettierPath);
    case "secrets":
    case "duplication":
      return [];
  }
}

function ownsPath(target: CheckTarget, path: string): boolean {
  return (
    target.kind === "repository" ||
    target.relativeRoot === "." ||
    path.startsWith(`${target.relativeRoot}/`)
  );
}

function actualRelevantPaths(
  checkId: CheckId,
  target: CheckTarget,
  inspection: RepositoryInspection,
  changeSet: ChangeSet,
): readonly string[] {
  const paths = targetWorkspaces(target, inspection).flatMap((workspace) =>
    workspacePaths(checkId, workspace),
  );
  if (checkId === "vulnerabilities" && target.kind === "repository") {
    paths.push(...inspection.lockfiles);
  }
  if (checkId === "formatting" || checkId === "secrets") {
    paths.push(
      ...[...changeSet.files.values()]
        .filter(
          (file) =>
            file.status !== "deleted" &&
            (checkId === "secrets" || isSupportedPrettierPath(file.path)),
        )
        .map(({ path }) => path),
    );
  }
  return Object.freeze(
    [...new Set(paths.map(normalizeRepositoryRelativePath))].filter((path) =>
      ownsPath(target, path),
    ),
  );
}

export function shouldScheduleTarget(
  checkId: CheckId,
  target: CheckTarget,
  targetPolicy: Readonly<ResolvedCheckPolicy>,
  inspection: RepositoryInspection,
  changeSet: ChangeSet,
  policyForFile: FilePolicyResolver,
): boolean {
  if (targetPolicy.severity !== "off") return true;
  if (checkId === "duplication") return false;

  const changed = new Set(
    [...changeSet.files.values()]
      .filter(({ status }) => status !== "deleted")
      .map(({ path }) => normalizeRepositoryRelativePath(path)),
  );
  return actualRelevantPaths(checkId, target, inspection, changeSet).some(
    (path) => {
      const policy = policyForFile(checkId, path, "target");
      return (
        policy.severity !== "off" &&
        (policy.when === "always" || changed.has(path))
      );
    },
  );
}
