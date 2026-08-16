import { posix } from "node:path";
import {
  canonicalizeSnapshotRoot,
  normalizeRepositoryPath,
} from "./read-json.js";
import type { ContainedFileReadHooks } from "./read-json.js";
import {
  captureSnapshotRegistry,
  type SnapshotRegistry,
} from "./snapshot-registry.js";
import { discoverWorkspaces, type DiscoveredWorkspace } from "./workspaces.js";
import type {
  Environment,
  PackageManager,
  RepositoryInspection,
  WorkspaceInspection,
} from "./types.js";
import { compareCodeUnits } from "../core/compare.js";

const LOCKFILE_MANAGERS = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
} as const satisfies Record<string, Exclude<PackageManager, "unknown">>;

const LOCKFILE_PRECEDENCE = ["npm", "pnpm", "yarn", "bun"] as const;
const SOURCE_EXTENSION = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
const TSCONFIG_NAME = /^tsconfig.*\.json$/;
const ENVIRONMENT_ORDER: readonly Environment[] = [
  "javascript",
  "typescript",
  "react",
  "react-dom",
  "ink",
  "next",
  "remix",
  "vitest",
  "jest",
  "testing-library",
];

function declaredPackageManager(
  value: string | undefined,
): PackageManager | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match =
    /^(npm|pnpm|yarn|bun)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value,
    );
  return match?.[1] as PackageManager | undefined;
}

function detectPackageManager(
  rootPackageManager: string | undefined,
  lockfiles: readonly string[],
): PackageManager {
  const declared = declaredPackageManager(rootPackageManager);
  if (declared !== undefined) {
    return declared;
  }
  const detected = new Set(
    lockfiles.map(
      (path) =>
        LOCKFILE_MANAGERS[
          path.split("/").at(-1) as keyof typeof LOCKFILE_MANAGERS
        ],
    ),
  );
  return (
    LOCKFILE_PRECEDENCE.find((manager) => detected.has(manager)) ?? "unknown"
  );
}

function discoverRepositoryFiles(
  registry: SnapshotRegistry,
  matches: (repositoryPath: string) => boolean,
): readonly string[] {
  return registry
    .entries()
    .filter(
      (entry) =>
        entry.kind === "file" &&
        entry.targetKind === "file" &&
        matches(entry.repositoryPath),
    )
    .map(({ repositoryPath }) => normalizeRepositoryPath(repositoryPath))
    .sort(compareCodeUnits);
}

function ownsPath(workspaceRoot: string, path: string): boolean {
  return workspaceRoot === "." || path.startsWith(`${workspaceRoot}/`);
}

function owningWorkspace(
  workspaces: readonly DiscoveredWorkspace[],
  path: string,
): DiscoveredWorkspace | undefined {
  return workspaces
    .filter((workspace) => ownsPath(workspace.relativeRoot, path))
    .sort(
      (left, right) => right.relativeRoot.length - left.relativeRoot.length,
    )[0];
}

function inferEnvironments(
  workspace: DiscoveredWorkspace,
  sourceFiles: readonly string[],
  tsconfigPaths: readonly string[],
): readonly Environment[] {
  const dependencies = workspace.manifest.dependencyNames;
  const environments = new Set<Environment>(["javascript"]);
  const hasTypeScriptSource = sourceFiles.some((path) =>
    /\.(?:ts|tsx|mts|cts)$/.test(path),
  );
  if (
    dependencies.has("typescript") ||
    hasTypeScriptSource ||
    tsconfigPaths.length > 0
  ) {
    environments.add("typescript");
  }

  const hasNext = dependencies.has("next");
  const hasRemix =
    dependencies.has("remix") || dependencies.has("@remix-run/react");
  if (dependencies.has("react") || hasNext || hasRemix) {
    environments.add("react");
  }
  if (dependencies.has("react-dom") || hasNext || hasRemix) {
    environments.add("react-dom");
  }
  if (dependencies.has("ink")) {
    environments.add("ink");
  }
  if (hasNext) {
    environments.add("next");
  }
  if (hasRemix) {
    environments.add("remix");
  }
  if (dependencies.has("vitest")) {
    environments.add("vitest");
  }
  if (dependencies.has("jest")) {
    environments.add("jest");
  }
  if ([...dependencies].some((name) => name.startsWith("@testing-library/"))) {
    environments.add("testing-library");
  }
  return ENVIRONMENT_ORDER.filter((environment) =>
    environments.has(environment),
  );
}

function freezeWorkspace(workspace: WorkspaceInspection): WorkspaceInspection {
  Object.freeze(workspace.sourceFiles);
  Object.freeze(workspace.tsconfigPaths);
  Object.freeze(workspace.environments);
  if (workspace.productionDependencies !== undefined) {
    Object.freeze(workspace.productionDependencies);
  }
  if (workspace.developmentDependencies !== undefined) {
    Object.freeze(workspace.developmentDependencies);
  }
  return Object.freeze(workspace);
}

export async function inspectRepository(
  snapshotRoot: string,
  dependencies: {
    readHooks?(repositoryPath: string): ContainedFileReadHooks | undefined;
  } = {},
): Promise<RepositoryInspection> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  const registry = await captureSnapshotRegistry(canonicalRoot);
  const readHooks = dependencies.readHooks ?? (() => undefined);
  const workspaces = await discoverWorkspaces(registry, readHooks);
  const sourceFiles = discoverRepositoryFiles(registry, (path) =>
    SOURCE_EXTENSION.test(path),
  );
  const tsconfigPaths = discoverRepositoryFiles(registry, (path) =>
    TSCONFIG_NAME.test(posix.basename(path)),
  );
  const discoveredLockfiles = discoverRepositoryFiles(
    registry,
    (path) => posix.basename(path) in LOCKFILE_MANAGERS,
  );

  const sourcesByWorkspace = new Map<DiscoveredWorkspace, string[]>();
  const configsByWorkspace = new Map<DiscoveredWorkspace, string[]>();
  for (const workspace of workspaces) {
    sourcesByWorkspace.set(workspace, []);
    configsByWorkspace.set(workspace, []);
  }
  const claimedSourceFiles = new Set<string>();
  const claimedConfigPaths = new Set<string>();
  for (const workspace of workspaces) {
    if (workspace.canonicalRelativeRoot === workspace.relativeRoot) continue;
    for (const path of sourceFiles) {
      if (!ownsPath(workspace.canonicalRelativeRoot, path)) continue;
      const suffix = path
        .slice(workspace.canonicalRelativeRoot.length)
        .replace(/^\//, "");
      sourcesByWorkspace
        .get(workspace)
        ?.push(posix.join(workspace.relativeRoot, suffix));
      claimedSourceFiles.add(path);
    }
    for (const path of tsconfigPaths) {
      if (!ownsPath(workspace.canonicalRelativeRoot, path)) continue;
      const suffix = path
        .slice(workspace.canonicalRelativeRoot.length)
        .replace(/^\//, "");
      configsByWorkspace
        .get(workspace)
        ?.push(posix.join(workspace.relativeRoot, suffix));
      claimedConfigPaths.add(path);
    }
  }
  for (const path of sourceFiles) {
    if (claimedSourceFiles.has(path)) continue;
    const owner = owningWorkspace(workspaces, path);
    if (owner !== undefined) {
      sourcesByWorkspace.get(owner)?.push(path);
    }
  }
  for (const path of tsconfigPaths) {
    if (claimedConfigPaths.has(path)) continue;
    const owner = owningWorkspace(workspaces, path);
    if (owner !== undefined) {
      configsByWorkspace.get(owner)?.push(path);
    }
  }

  const inspectedWorkspaces = workspaces.map((workspace) => {
    const workspaceSources = sourcesByWorkspace.get(workspace) ?? [];
    const workspaceConfigs = configsByWorkspace.get(workspace) ?? [];
    return freezeWorkspace({
      ...(workspace.manifest.name === undefined
        ? {}
        : { name: workspace.manifest.name }),
      relativeRoot: workspace.relativeRoot,
      manifestPath: workspace.manifestPath,
      sourceFiles: workspaceSources,
      tsconfigPaths: workspaceConfigs,
      environments: [
        ...inferEnvironments(workspace, workspaceSources, workspaceConfigs),
      ],
      productionDependencies: [
        ...workspace.manifest.productionDependencyNames,
      ].sort(compareCodeUnits),
      developmentDependencies: [
        ...workspace.manifest.developmentDependencyNames,
      ].sort(compareCodeUnits),
    });
  });
  const lockfiles = [...discoveredLockfiles].sort(compareCodeUnits);
  const rootPackageManager = workspaces.find(
    ({ relativeRoot }) => relativeRoot === ".",
  )?.manifest.packageManager;
  const inspection: RepositoryInspection = {
    snapshotRoot: canonicalRoot,
    packageManager: detectPackageManager(rootPackageManager, lockfiles),
    lockfiles,
    workspaces: inspectedWorkspaces,
  };
  Object.freeze(lockfiles);
  Object.freeze(inspectedWorkspaces);
  return Object.freeze(inspection);
}

export type { RepositoryInspection, WorkspaceInspection } from "./types.js";
