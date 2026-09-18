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
  if (!isContainedPath(canonicalRoot, canonicalManifest)) return undefined;
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

function declaredPrettierRange(manifest: {
  dependencyDeclarations: readonly {
    readonly name: string;
    readonly specifier: string;
  }[];
}): string | undefined {
  return manifest.dependencyDeclarations.find(
    (declaration) => declaration.name === PRETTIER_PACKAGE_NAME,
  )?.specifier;
}

function manifestPrettierConfig(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as { prettier?: unknown }).prettier;
}

async function configPathsForProject(
  registry: SnapshotRegistry,
  projectRoot: string,
): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const name of DATA_CONFIG_FILES) {
    const path = projectRoot === "." ? name : posix.join(projectRoot, name);
    if (registry.resolve(path)?.targetKind === "file") paths.push(path);
  }
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
): Promise<ProjectPrettierDiscovery | undefined> {
  const rawManifest = await readJsonData(registry, manifestPath);
  const prettierField = manifestPrettierConfig(rawManifest);
  const prettierFieldIsString = typeof prettierField === "string";
  const configPaths = await configPathsForProject(registry, projectRoot);
  const executableConfig =
    configPaths.some(executableConfigPath) || prettierFieldIsString;
  const declaredRange = declaredPrettierRange(manifest);
  const installed = await findInstalledPrettier(
    resolve(canonicalRoot, projectRoot),
    canonicalRoot,
  );
  const hasSetup =
    declaredRange !== undefined ||
    prettierField !== undefined ||
    configPaths.length > 0 ||
    installed !== undefined;
  if (!hasSetup) return undefined;

  const status: ProjectPrettierDiscovery["status"] =
    installed === undefined
      ? "missing"
      : isSupportedProjectPrettierVersion(installed.version)
        ? "available"
        : "unsupported";

  return Object.freeze({
    projectRoot,
    ...(installed === undefined ? {} : { version: installed.version }),
    ...(installed === undefined ? {} : { packageRoot: installed.packageRoot }),
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
  const results: ProjectPrettierDiscovery[] = [];
  for (const workspace of workspaces) {
    const discovery = await discoveryForProject(
      registry,
      canonicalRoot,
      workspace.relativeRoot,
      workspace.manifestPath,
      workspace.manifest,
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
