import { MANAGED_SOURCE_PATH } from "./source-paths.js";
import {
  workspaceContainsFile,
  physicalWorkspaceOrder,
} from "./workspace-owner.js";
import { posix, relative, sep } from "node:path";
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

export const LOCKFILE_MANAGERS = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
} as const satisfies Record<string, Exclude<PackageManager, "unknown">>;

function lockfileManager(name: string): PackageManager | undefined {
  return Object.hasOwn(LOCKFILE_MANAGERS, name)
    ? LOCKFILE_MANAGERS[name as keyof typeof LOCKFILE_MANAGERS]
    : undefined;
}

const LOCKFILE_PRECEDENCE = ["npm", "pnpm", "yarn", "bun"] as const;
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
    lockfiles.map((path) => lockfileManager(posix.basename(path))),
  );
  return (
    LOCKFILE_PRECEDENCE.find((manager) => detected.has(manager)) ?? "unknown"
  );
}

function discoverRepositoryFiles(
  registry: SnapshotRegistry,
  matches: (repositoryPath: string) => boolean,
  includeFileSymlinks = false,
): readonly string[] {
  return registry
    .entries()
    .filter(
      (entry) =>
        (entry.kind === "file" ||
          (includeFileSymlinks && entry.kind === "symlink")) &&
        entry.targetKind === "file" &&
        matches(entry.repositoryPath),
    )
    .map(({ repositoryPath }) => normalizeRepositoryPath(repositoryPath))
    .sort(compareCodeUnits);
}

function lockfilesAtProjectRoots(
  lockfiles: readonly string[],
  workspaces: readonly DiscoveredWorkspace[],
): readonly string[] {
  const projectRoots = new Set<string>(["."]);
  for (const workspace of workspaces) {
    projectRoots.add(workspace.relativeRoot);
    projectRoots.add(workspace.canonicalRelativeRoot);
  }
  return lockfiles.filter((path) => projectRoots.has(posix.dirname(path)));
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
  Object.freeze(workspace.dependencyDeclarations);
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
    registry?: SnapshotRegistry;
    readHooks?(repositoryPath: string): ContainedFileReadHooks | undefined;
  } = {},
): Promise<RepositoryInspection> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  const registry =
    dependencies.registry ?? (await captureSnapshotRegistry(canonicalRoot));
  const readHooks = dependencies.readHooks ?? (() => undefined);
  const workspaces = await discoverWorkspaces(registry, readHooks);
  for (const [path, failure] of registry.unavailableSymlinks ?? []) {
    const name = posix.basename(path);
    const required =
      MANAGED_SOURCE_PATH.test(path) ||
      TSCONFIG_NAME.test(name) ||
      name === "package.json" ||
      name === "pnpm-workspace.yaml" ||
      lockfileManager(name) !== undefined ||
      workspaces.some(({ relativeRoot, canonicalRelativeRoot }) =>
        [relativeRoot, canonicalRelativeRoot].some(
          (root) =>
            (failure.reason !== "excluded-symlink" &&
              workspaceContainsFile(root, path)) ||
            root === path ||
            root.startsWith(`${path}/`),
        ),
      );
    if (required) throw failure;
  }

  const sourceFiles = discoverRepositoryFiles(registry, (path) =>
    MANAGED_SOURCE_PATH.test(path),
  );
  const tsconfigPaths = discoverRepositoryFiles(
    registry,
    (path) => TSCONFIG_NAME.test(posix.basename(path)),
    true,
  );
  const discoveredLockfiles = lockfilesAtProjectRoots(
    discoverRepositoryFiles(
      registry,
      (path) => lockfileManager(posix.basename(path)) !== undefined,
    ),
    workspaces,
  );

  const sourcesByWorkspace = new Map<DiscoveredWorkspace, string[]>();
  const configsByWorkspace = new Map<DiscoveredWorkspace, string[]>();
  for (const workspace of workspaces) {
    sourcesByWorkspace.set(workspace, []);
    configsByWorkspace.set(workspace, []);
  }
  const unownedSourceFiles: string[] = [];
  // Registry members use canonical spellings. Choose the deepest physical
  // project first, then project the path into that declared owner's spelling.
  // Equal physical roots prefer the real declaration, then a stable alias.
  const owners = physicalWorkspaceOrder(workspaces);
  function assign(
    path: string,
    byWorkspace: Map<DiscoveredWorkspace, string[]>,
  ): boolean {
    const owner = owners.find(({ canonicalRelativeRoot }) =>
      workspaceContainsFile(canonicalRelativeRoot, path),
    );
    if (owner === undefined) return false;
    const suffix =
      owner.canonicalRelativeRoot === "."
        ? path
        : path.slice(owner.canonicalRelativeRoot.length + 1);
    byWorkspace.get(owner)!.push(posix.join(owner.relativeRoot, suffix));
    return true;
  }
  for (const path of sourceFiles) {
    if (!assign(path, sourcesByWorkspace)) unownedSourceFiles.push(path);
  }
  for (const path of tsconfigPaths) assign(path, configsByWorkspace);

  const inspectedWorkspaces = workspaces.map((workspace) => {
    const workspaceSources = sourcesByWorkspace.get(workspace) ?? [];
    const workspaceConfigs = configsByWorkspace.get(workspace) ?? [];
    return freezeWorkspace({
      ...(workspace.manifest.name === undefined
        ? {}
        : { name: workspace.manifest.name }),
      relativeRoot: workspace.relativeRoot,
      ...(workspace.canonicalRelativeRoot === workspace.relativeRoot
        ? {}
        : { canonicalRelativeRoot: workspace.canonicalRelativeRoot }),
      manifestPath: workspace.manifestPath,
      sourceFiles: workspaceSources,
      tsconfigPaths: workspaceConfigs,
      environments: [
        ...inferEnvironments(workspace, workspaceSources, workspaceConfigs),
      ],
      dependencyDeclarations: workspace.manifest.dependencyDeclarations,
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
  const symlinkTargets = new Set<string>();
  for (const entry of registry.entries()) {
    if (entry.kind === "symlink" && entry.targetKind === "file")
      symlinkTargets.add(
        relative(canonicalRoot, entry.canonicalPath).split(sep).join("/"),
      );
  }
  const inspection: RepositoryInspection = {
    snapshotRoot: canonicalRoot,
    fileSymlinkTargets: Object.freeze(
      [...symlinkTargets].sort(compareCodeUnits),
    ),
    unownedSourceFiles: Object.freeze(unownedSourceFiles),
    packageManager: detectPackageManager(rootPackageManager, lockfiles),
    lockfiles,
    workspaces: inspectedWorkspaces,
  };
  Object.freeze(lockfiles);
  Object.freeze(inspectedWorkspaces);
  return Object.freeze(inspection);
}

export type { RepositoryInspection, WorkspaceInspection } from "./types.js";
