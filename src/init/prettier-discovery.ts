import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import semver from "semver";
import { compareCodeUnits } from "../core/compare.js";
import {
  canonicalizeSnapshotRoot,
  isContainedPath,
  readJsonData,
} from "../inspection/read-json.js";
import { captureSnapshotRegistry } from "../inspection/snapshot-registry.js";
import { discoverWorkspaces } from "../inspection/workspaces.js";
import type { SnapshotRegistry } from "../inspection/snapshot-registry.js";

export const SUPPORTED_PROJECT_PRETTIER_RANGE = ">=3.0.0 <4.0.0";

const PRETTIER_PACKAGE_NAME = "prettier";
const NODE_MODULES = "node_modules";
const MANIFEST_MAX_BYTES = 1024 * 1024;
const PRETTIER_MANIFEST_MAX_BYTES = 1024 * 1024;

export interface ProjectPrettierDiscovery {
  /** Normalized repository-relative project root; "." for the repository root. */
  readonly projectRoot: string;
  readonly version?: string;
  /** Validated absolute realpath; internal only, never persisted to tracked config. */
  readonly packageRoot?: string;
  readonly declaredRange?: string;
  readonly configPaths: readonly string[];
  readonly executableConfig: boolean;
  readonly status: "available" | "missing" | "unsupported";
}

const DATA_CONFIG_FILES = [
  "prettier.config.js",
  "prettier.config.mjs",
  "prettier.config.cjs",
  "prettier.config.ts",
  "prettier.config.cts",
  "prettier.config.mts",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.json5",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.toml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.ts",
  ".prettierrc.cts",
  ".prettierrc.mts",
] as const;

const EXECUTABLE_CONFIG_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".cts",
  ".mts",
]);

export function isSupportedProjectPrettierVersion(version: string): boolean {
  const normalized = semver.valid(version);
  return normalized !== null && semver.satisfies(normalized, SUPPORTED_PROJECT_PRETTIER_RANGE);
}

/**
 * An installed version is accepted only when it satisfies the supported
 * engine range and, when the project declares a semver range, that exact
 * declaration. Non-semver declarations (URLs, tags, `workspace:*`) do not
 * restrict the installed version here; the engine revalidates against the
 * selected snapshot before executing anything.
 */
export function isProjectPrettierVersionAccepted(
  version: string,
  declaredRange: string | undefined,
): boolean {
  if (!isSupportedProjectPrettierVersion(version)) return false;
  if (declaredRange === undefined) return true;
  const normalizedRange = semver.validRange(declaredRange);
  if (normalizedRange === null) return true;
  try {
    return semver.satisfies(semver.valid(version)!, normalizedRange);
  } catch {
    return false;
  }
}

function executableConfigPath(path: string): boolean {
  const extension = path.slice(path.lastIndexOf("."));
  return EXECUTABLE_CONFIG_EXTENSIONS.has(extension);
}

async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile() || metadata.size > BigInt(maxBytes)) {
    throw new Error("File is not a bounded regular file");
  }
  return readFile(path, "utf8");
}

interface InstalledPrettier {
  readonly packageRoot: string;
  readonly version: string;
}

async function installedPrettierAt(
  directory: string,
  canonicalRoot: string,
): Promise<InstalledPrettier | undefined> {
  const manifestPath = resolve(
    directory,
    NODE_MODULES,
    PRETTIER_PACKAGE_NAME,
    "package.json",
  );
  let canonicalManifest: string;
  try {
    canonicalManifest = await realpath(manifestPath);
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readBoundedFile(canonicalManifest, PRETTIER_MANIFEST_MAX_BYTES),
    ) as unknown;
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { version?: unknown }).version !== "string"
  ) {
    return undefined;
  }
  return {
    packageRoot: dirname(canonicalManifest),
    version: (parsed as { version: string }).version,
  };
}

async function findInstalledPrettier(
  projectRootAbsolute: string,
  canonicalRoot: string,
): Promise<InstalledPrettier | undefined> {
  let current = projectRootAbsolute;
  while (isContainedPath(canonicalRoot, current)) {
    const found = await installedPrettierAt(current, canonicalRoot);
    if (found !== undefined) return found;
    if (current === canonicalRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function manifestPrettierRange(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = (value as Record<string, unknown>)[section];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    const specifier = (dependencies as Record<string, unknown>).prettier;
    if (typeof specifier === "string") return specifier;
  }
  return undefined;
}

async function declaredPrettierRangeForProject(
  registry: SnapshotRegistry,
  projectRoot: string,
  projectManifest: unknown,
): Promise<string | undefined> {
  let current = projectRoot;
  while (true) {
    let value: unknown = projectManifest;
    if (current !== projectRoot) {
      const manifestPath =
        current === "." ? "package.json" : posix.join(current, "package.json");
      if (registry.resolve(manifestPath)?.targetKind === "file") {
        try {
          value = await readJsonData(registry, manifestPath);
        } catch {
          value = undefined;
        }
      } else {
        value = undefined;
      }
    }
    const declaredRange = manifestPrettierRange(value);
    if (declaredRange !== undefined) return declaredRange;
    if (current === ".") return undefined;
    current = posix.dirname(current);
  }
}

function manifestPrettierConfig(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as { prettier?: unknown }).prettier;
}

async function configPathsForProject(
  registry: SnapshotRegistry,
  projectRoot: string,
  projectRoots: readonly string[],
): Promise<readonly string[]> {
  const prefix = projectRoot === "." ? "" : `${projectRoot}/`;
  const nestedRoots = projectRoots
    .filter(
      (root) =>
        root !== projectRoot &&
        (projectRoot === "." || root.startsWith(`${projectRoot}/`)),
    )
    .map((root) => `${root}/`);
  const names = new Set<string>(DATA_CONFIG_FILES);
  const paths = registry
    .entries()
    .filter(
      (entry) =>
        entry.targetKind === "file" &&
        entry.repositoryPath.startsWith(prefix) &&
        !nestedRoots.some((root) => entry.repositoryPath.startsWith(root)) &&
        names.has(posix.basename(entry.repositoryPath)),
    )
    .map((entry) => entry.repositoryPath);
  return Object.freeze(paths.sort(compareCodeUnits));
}

async function discoveryForProject(
  registry: SnapshotRegistry,
  canonicalRoot: string,
  projectRoot: string,
  manifestPath: string,
  manifest: {
    dependencyDeclarations: readonly {
      readonly name: string;
      readonly specifier: string;
    }[];
  },
  projectRoots: readonly string[],
): Promise<ProjectPrettierDiscovery | undefined> {
  const rawManifest = await readJsonData(registry, manifestPath);
  const prettierField = manifestPrettierConfig(rawManifest);
  const prettierFieldIsString = typeof prettierField === "string";
  const configPaths = await configPathsForProject(
    registry,
    projectRoot,
    projectRoots,
  );
  const executableConfig =
    configPaths.some(executableConfigPath) || prettierFieldIsString;
  const declaredRange = await declaredPrettierRangeForProject(
    registry,
    projectRoot,
    rawManifest,
  );
  const installed = await findInstalledPrettier(
    resolve(canonicalRoot, projectRoot),
    canonicalRoot,
  );
  // An installed copy alone is not a project setup: npm can hoist Zedbee's own
  // transitive Prettier into the repository root, and that must never be
  // offered as the project's formatter. A project setup exists only when the
  // project declares Prettier or configures it natively.
  const hasSetup =
    declaredRange !== undefined ||
    prettierField !== undefined ||
    configPaths.length > 0;
  if (!hasSetup) return undefined;

  const usableInstallation = declaredRange === undefined ? undefined : installed;
  const status: ProjectPrettierDiscovery["status"] = usableInstallation === undefined
    ? "missing"
    : isProjectPrettierVersionAccepted(
        usableInstallation.version,
        declaredRange,
      )
      ? "available"
      : "unsupported";

  return Object.freeze({
    projectRoot,
    ...(usableInstallation === undefined
      ? {}
      : { version: usableInstallation.version }),
    ...(usableInstallation === undefined
      ? {}
      : { packageRoot: usableInstallation.packageRoot }),
    ...(declaredRange === undefined ? {} : { declaredRange }),
    configPaths,
    executableConfig,
    status,
  });
}

export async function discoverProjectPrettier(
  repositoryRoot: string,
): Promise<readonly ProjectPrettierDiscovery[]> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await canonicalizeSnapshotRoot(repositoryRoot);
  } catch {
    return Object.freeze([]);
  }
  const registry = await captureSnapshotRegistry(canonicalRoot);
  const workspaces = await discoverWorkspaces(registry);
  const projectRoots = workspaces.map((workspace) => workspace.relativeRoot);
  const results: ProjectPrettierDiscovery[] = [];
  for (const workspace of workspaces) {
    const discovery = await discoveryForProject(
      registry,
      canonicalRoot,
      workspace.relativeRoot,
      workspace.manifestPath,
      workspace.manifest,
      projectRoots,
    );
    if (discovery !== undefined) results.push(discovery);
  }
  return Object.freeze(
    results.sort((left, right) =>
      compareCodeUnits(left.projectRoot, right.projectRoot),
    ),
  );
}

/** Internal helper for tests and Task 4; never exported through the CLI surface. */
export function repositoryRelativePath(
  canonicalRoot: string,
  path: string,
): string | undefined {
  const fromRoot = relative(canonicalRoot, path).split(sep).join("/");
  if (
    fromRoot === "" ||
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith("../")
  ) {
    return undefined;
  }
  return fromRoot;
}
