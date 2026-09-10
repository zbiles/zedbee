import { posix, relative } from "node:path";
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import {
  normalizeRepositoryPath,
  readContainedFile,
  readJsonData,
  type ContainedFileReadHooks,
} from "./read-json.js";
import type { SnapshotRegistry } from "./snapshot-registry.js";
import {
  RepositoryInspectionError,
  type DependencyDeclaration,
  type DependencySection,
} from "./types.js";
import { compareCodeUnits } from "../core/compare.js";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "devDependencies",
  "peerDependencies",
] as const satisfies readonly DependencySection[];

const MODULE_RESOLUTION_FIELDS = new Set([
  "type",
  "main",
  "module",
  "imports",
  "exports",
  "types",
  "typings",
]);

export interface PackageManifest {
  readonly name?: string;
  readonly packageManager?: string;
  readonly workspacePatterns: readonly string[];
  readonly dependencyNames: ReadonlySet<string>;
  readonly productionDependencyNames: ReadonlySet<string>;
  readonly developmentDependencyNames: ReadonlySet<string>;
  readonly dependencyDeclarations: readonly DependencyDeclaration[];
}

export interface DiscoveredWorkspace {
  readonly relativeRoot: string;
  readonly canonicalRelativeRoot: string;
  readonly manifestPath: string;
  readonly manifest: PackageManifest;
}

export type ReadHooksResolver = (
  repositoryPath: string,
) => ContainedFileReadHooks | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidData(path: string): RepositoryInspectionError {
  return new RepositoryInspectionError(
    "INVALID_SNAPSHOT_DATA",
    `Zedbee found invalid repository data in ${path}.`,
  );
}

function readStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalidData(path);
  }
  return value;
}

export function parsePackageManifest(
  value: unknown,
  path: string,
): PackageManifest {
  if (!isRecord(value)) {
    throw invalidData(path);
  }
  if (value.name !== undefined && typeof value.name !== "string") {
    throw invalidData(path);
  }
  if (
    value.packageManager !== undefined &&
    typeof value.packageManager !== "string"
  ) {
    throw invalidData(path);
  }

  let workspacePatterns: readonly string[] = [];
  if (value.workspaces !== undefined) {
    if (Array.isArray(value.workspaces)) {
      workspacePatterns = readStringArray(value.workspaces, path);
    } else if (
      isRecord(value.workspaces) &&
      value.workspaces.packages !== undefined
    ) {
      workspacePatterns = readStringArray(value.workspaces.packages, path);
    } else {
      throw invalidData(path);
    }
  }

  const dependencyNames = new Set<string>();
  const productionDependencyNames = new Set<string>();
  const developmentDependencyNames = new Set<string>();
  const dependencyDeclarations: DependencyDeclaration[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = value[section];
    if (dependencies === undefined) {
      continue;
    }
    if (!isRecord(dependencies)) {
      throw invalidData(path);
    }
    for (const dependencyName of Object.keys(dependencies).sort(
      compareCodeUnits,
    )) {
      const specifier = dependencies[dependencyName];
      if (typeof specifier !== "string") {
        throw invalidData(path);
      }
      dependencyNames.add(dependencyName);
      if (section === "devDependencies") {
        developmentDependencyNames.add(dependencyName);
      } else {
        productionDependencyNames.add(dependencyName);
      }
      dependencyDeclarations.push(
        Object.freeze({ name: dependencyName, specifier, section }),
      );
    }
  }

  return {
    ...(value.name === undefined ? {} : { name: value.name as string }),
    ...(value.packageManager === undefined
      ? {}
      : { packageManager: value.packageManager as string }),
    workspacePatterns,
    dependencyNames,
    productionDependencyNames,
    developmentDependencyNames,
    dependencyDeclarations: Object.freeze(dependencyDeclarations),
  };
}

function pathExists(registry: SnapshotRegistry, path: string): boolean {
  return registry.resolve(path)?.targetKind === "file";
}

function normalizeWorkspacePattern(pattern: string): string {
  const negated = pattern.startsWith("!");
  const rawPattern = negated ? pattern.slice(1) : pattern;
  const normalized = rawPattern
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw invalidData("workspace configuration");
  }
  return negated ? `!${normalized}` : normalized;
}

function matchesWorkspacePattern(
  path: string,
  patterns: readonly string[],
): boolean {
  const positivePatterns = patterns.filter(
    (pattern) => !pattern.startsWith("!"),
  );
  const negativePatterns = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  try {
    return (
      positivePatterns.some((pattern) =>
        picomatch.isMatch(path, pattern, { dot: true }),
      ) &&
      !negativePatterns.some((pattern) =>
        picomatch.isMatch(path, pattern, { dot: true }),
      )
    );
  } catch {
    throw invalidData("workspace configuration");
  }
}

function discoverSelectedWorkspaceManifests(
  registry: SnapshotRegistry,
  patterns: readonly string[],
): readonly string[] {
  if (patterns.length === 0) {
    return [];
  }
  const manifests = new Set<string>();
  for (const entry of registry.entries()) {
    if (
      entry.targetKind === "file" &&
      posix.basename(entry.repositoryPath) === "package.json"
    ) {
      const workspaceRoot = posix.dirname(entry.repositoryPath);
      if (
        workspaceRoot !== "." &&
        matchesWorkspacePattern(workspaceRoot, patterns)
      ) {
        manifests.add(entry.repositoryPath);
      }
    }

    if (
      entry.kind === "symlink" &&
      entry.targetKind === "directory" &&
      matchesWorkspacePattern(entry.repositoryPath, patterns)
    ) {
      const manifestPath = posix.join(entry.repositoryPath, "package.json");
      if (pathExists(registry, manifestPath)) {
        manifests.add(manifestPath);
      }
    }
  }
  return [...manifests];
}

async function readPnpmWorkspacePatterns(
  registry: SnapshotRegistry,
  readHooks: ReadHooksResolver,
  relativeRoot = ".",
): Promise<readonly string[]> {
  const repositoryPath = posix.join(relativeRoot, "pnpm-workspace.yaml");
  if (!pathExists(registry, repositoryPath)) {
    return [];
  }
  const contents = await readContainedFile(
    registry,
    repositoryPath,
    readHooks(repositoryPath),
  );
  let parsed: unknown;
  try {
    parsed = parseYaml(contents);
  } catch {
    throw new RepositoryInspectionError(
      "INVALID_SNAPSHOT_DATA",
      `Zedbee could not parse ${repositoryPath} as YAML.`,
    );
  }
  if (!isRecord(parsed) || parsed.packages === undefined) {
    throw invalidData(repositoryPath);
  }
  return readStringArray(parsed.packages, repositoryPath);
}

export async function discoverWorkspaces(
  registry: SnapshotRegistry,
  readHooks: ReadHooksResolver = () => undefined,
): Promise<readonly DiscoveredWorkspace[]> {
  const rootManifestPath = "package.json";
  const hasRootManifest = pathExists(registry, rootManifestPath);
  const rootManifest = hasRootManifest
    ? parsePackageManifest(
        await readJsonData(
          registry,
          rootManifestPath,
          readHooks(rootManifestPath),
        ),
        rootManifestPath,
      )
    : undefined;
  const workspacePatterns = [
    ...(rootManifest?.workspacePatterns ?? []),
    ...(await readPnpmWorkspacePatterns(registry, readHooks)),
  ].map(normalizeWorkspacePattern);
  // Explicit workspace patterns remain authoritative. Otherwise, independent
  // projects may live below a non-JavaScript repository root.
  const discoverIndependentProjects = workspacePatterns.length === 0;
  const matchedManifests = discoverIndependentProjects
    ? registry
        .entries()
        .filter(
          (entry) =>
            entry.targetKind === "file" &&
            posix.basename(entry.repositoryPath) === "package.json",
        )
        .map((entry) => entry.repositoryPath)
    : discoverSelectedWorkspaceManifests(registry, workspacePatterns);

  const selectedManifestPaths = [
    ...new Set(matchedManifests.map(normalizeRepositoryPath)),
  ]
    .filter((path) => path !== rootManifestPath)
    .sort(
      (left, right) =>
        left.split("/").length - right.split("/").length ||
        compareCodeUnits(left, right),
    );
  const workspaces: DiscoveredWorkspace[] = [];
  const independentWorkspacePatterns = new Map<string, readonly string[]>();
  if (rootManifest !== undefined) {
    workspaces.push({
      relativeRoot: ".",
      canonicalRelativeRoot: ".",
      manifestPath: rootManifestPath,
      manifest: rootManifest,
    });
  }
  for (const manifestPath of selectedManifestPaths) {
    const relativeRoot = posix.dirname(manifestPath);
    let explicitlySelected = !discoverIndependentProjects;
    if (discoverIndependentProjects) {
      const declaredParent = workspaces
        .filter(
          (workspace) =>
            relativeRoot.startsWith(`${workspace.relativeRoot}/`) &&
            (independentWorkspacePatterns.get(workspace.relativeRoot)?.length ??
              0) > 0,
        )
        .sort(
          (left, right) => right.relativeRoot.length - left.relativeRoot.length,
        )[0];
      if (
        declaredParent !== undefined &&
        !matchesWorkspacePattern(
          posix.relative(declaredParent.relativeRoot, relativeRoot),
          independentWorkspacePatterns.get(declaredParent.relativeRoot)!,
        )
      )
        continue;
      explicitlySelected = declaredParent !== undefined;
    }
    const registeredManifest = registry.resolve(manifestPath);
    if (registeredManifest?.targetKind !== "file") {
      throw invalidData(manifestPath);
    }
    const registeredWorkspace = registry.resolve(relativeRoot);
    if (registeredWorkspace?.targetKind !== "directory") {
      throw invalidData(manifestPath);
    }
    const canonicalRelativeRoot =
      registeredWorkspace.canonicalPath !== registeredWorkspace.absolutePath
        ? normalizeRepositoryPath(
            relative(registry.snapshotRoot, registeredWorkspace.canonicalPath),
          )
        : relativeRoot;
    const manifestValue = await readJsonData(
      registry,
      manifestPath,
      readHooks(manifestPath),
    );
    const manifest = parsePackageManifest(manifestValue, manifestPath);
    const pnpmWorkspacePatterns = discoverIndependentProjects
      ? await readPnpmWorkspacePatterns(registry, readHooks, relativeRoot)
      : [];
    if (
      !explicitlySelected &&
      pnpmWorkspacePatterns.length === 0 &&
      workspaces.some(
        (workspace) =>
          workspace.relativeRoot === "." ||
          relativeRoot.startsWith(`${workspace.relativeRoot}/`),
      ) &&
      isRecord(manifestValue) &&
      Object.keys(manifestValue).length > 0 &&
      Object.keys(manifestValue).every((key) =>
        MODULE_RESOLUTION_FIELDS.has(key),
      )
    ) {
      // A nested package.json can scope module resolution without defining a
      // separate project; its sources retain their existing project owner.
      continue;
    }
    if (discoverIndependentProjects) {
      independentWorkspacePatterns.set(
        relativeRoot,
        [...manifest.workspacePatterns, ...pnpmWorkspacePatterns].map(
          normalizeWorkspacePattern,
        ),
      );
    }
    workspaces.push({
      relativeRoot,
      canonicalRelativeRoot:
        canonicalRelativeRoot === "" ? "." : canonicalRelativeRoot,
      manifestPath,
      manifest,
    });
  }
  return workspaces.sort((left, right) =>
    compareCodeUnits(left.relativeRoot, right.relativeRoot),
  );
}
