import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import type { FilePolicyResolver } from "../config/file-policy.js";
import type {
  CheckId,
  ResolvedCheckPolicy,
  ResolvedConfig,
} from "../config/schema.js";
import { snapshotManagedPolicy } from "../config/settings-registry.js";
import type { ChangeSet } from "../git/change-set.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../inspection/types.js";
import type { CheckTarget } from "./adapter.js";
import { isSupportedPrettierPath } from "./prettier/supported-path.js";

const JAVASCRIPT_SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/iu;
const FILE_SCOPED_CHECKS = new Set<CheckId>([
  "formatting",
  "lint",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "structuralSecurity",
  "secrets",
  "reactCorrectness",
  "reactAccessibility",
]);

export function resolveInspectionPolicy(
  config: ResolvedConfig,
  checkId: CheckId,
): Readonly<ResolvedCheckPolicy> {
  const root = config.checks[checkId];
  const patches = config.overrides
    .map((override) => override.checks[checkId])
    .filter((patch) => patch !== undefined);
  if (patches.some((patch) => patch.onUnavailable !== undefined)) {
    throw new TypeError(
      "Vulnerability availability policy cannot be overridden by file scope",
    );
  }
  const severities = [
    root.severity,
    ...patches.map((patch) => patch.severity),
  ].filter((severity) => severity !== undefined && severity !== "off");
  const severity = severities.includes("error")
    ? "error"
    : severities.includes("warn")
      ? "warn"
      : root.severity;
  const when =
    root.when === "always" || patches.some((patch) => patch.when === "always")
      ? "always"
      : "relevant";
  return snapshotManagedPolicy(checkId, { ...root, severity, when });
}

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
  if (!FILE_SCOPED_CHECKS.has(checkId)) {
    return targetPolicy.severity !== "off";
  }

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
