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
): Promise<readonly string[]> {
  const repositoryPath = "pnpm-workspace.yaml";
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
      "Zedbee could not parse pnpm-workspace.yaml as YAML.",
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
  const matchedManifests = discoverSelectedWorkspaceManifests(
    registry,
    workspacePatterns,
  );

  const selectedManifestPaths = [
    ...new Set(matchedManifests.map(normalizeRepositoryPath)),
  ]
    .filter((path) => path !== rootManifestPath)
    .sort(compareCodeUnits);
  const workspaces: DiscoveredWorkspace[] = [];
  if (rootManifest !== undefined) {
    workspaces.push({
      relativeRoot: ".",
      canonicalRelativeRoot: ".",
      manifestPath: rootManifestPath,
      manifest: rootManifest,
    });
  }
  for (const manifestPath of selectedManifestPaths) {
    const registeredManifest = registry.resolve(manifestPath);
    if (registeredManifest?.targetKind !== "file") {
      throw invalidData(manifestPath);
    }
    const relativeRoot = posix.dirname(manifestPath);
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
    workspaces.push({
      relativeRoot,
      canonicalRelativeRoot:
        canonicalRelativeRoot === "" ? "." : canonicalRelativeRoot,
      manifestPath,
      manifest: parsePackageManifest(
        await readJsonData(registry, manifestPath, readHooks(manifestPath)),
        manifestPath,
      ),
    });
  }
  return workspaces;
}
