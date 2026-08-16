import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareCodeUnits } from "../../core/compare.js";
import { readJsonData } from "../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";

const ISSUE_TYPES = [
  "files",
  "dependencies",
  "devDependencies",
  "unlisted",
  "unresolved",
  "exports",
  "types",
  "nsExports",
  "nsTypes",
  "duplicates",
] as const;

const IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/vendor/**",
] as const;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid package manifest");
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, depth = 0): readonly string[] {
  if (depth > 8)
    throw new TypeError("Package entrypoints are too deeply nested");
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((candidate) => strings(candidate, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.keys(value as Record<string, unknown>)
      .sort(compareCodeUnits)
      .flatMap((key) =>
        strings((value as Record<string, unknown>)[key], depth + 1),
      );
  }
  if (value === undefined || value === null || value === false) return [];
  throw new TypeError("Invalid package entrypoint");
}

function entrypointStrings(
  manifest: Record<string, unknown>,
): readonly string[] {
  const bin = manifest.bin;
  const binEntries =
    typeof bin === "object" && bin !== null && !Array.isArray(bin)
      ? Object.values(bin as Record<string, unknown>)
      : strings(bin);
  return [
    ...strings(manifest.main),
    ...strings(manifest.module),
    ...strings(manifest.types),
    ...strings(manifest.exports),
    ...binEntries.flatMap((candidate) => strings(candidate)),
  ];
}

function workspacePath(workspace: WorkspaceInspection, path: string): string {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
  ) {
    throw new TypeError("Package entrypoint escaped the workspace");
  }
  const normalized = posix.normalize(path.replace(/^\.\//u, ""));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError("Package entrypoint escaped the workspace");
  }
  const repositoryPath =
    workspace.relativeRoot === "."
      ? normalized
      : posix.join(workspace.relativeRoot, normalized);
  return repositoryPath;
}

function relativeToWorkspace(
  workspace: WorkspaceInspection,
  path: string,
): string {
  return workspace.relativeRoot === "."
    ? path
    : path.slice(workspace.relativeRoot.length + 1);
}

export interface ManagedKnipConfig {
  readonly [key: string]: unknown;
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly workspaces: Readonly<
    Record<
      string,
      {
        readonly entry: readonly string[];
        readonly project: readonly string[];
        readonly ignore: readonly string[];
      }
    >
  >;
}

async function disabledPinnedPlugins(): Promise<
  Readonly<Record<string, false>>
> {
  const knipModule = fileURLToPath(import.meta.resolve("knip"));
  const pluginModule = (await import(
    pathToFileURL(join(dirname(knipModule), "types", "PluginNames.js")).href
  )) as { readonly pluginNames?: unknown };
  if (
    !Array.isArray(pluginModule.pluginNames) ||
    pluginModule.pluginNames.some(
      (name) =>
        typeof name !== "string" ||
        name.length === 0 ||
        name.trim() !== name ||
        !/^[a-z0-9][a-z0-9-]*$/u.test(name),
    )
  ) {
    throw new TypeError("Invalid pinned Knip plugin inventory");
  }
  return Object.freeze(
    Object.fromEntries(
      [...pluginModule.pluginNames]
        .sort(compareCodeUnits)
        .map((name) => [name, false]),
    ),
  );
}

export async function createManagedKnipConfig(
  snapshotRoot: string,
  inspection: RepositoryInspection,
): Promise<ManagedKnipConfig> {
  if (inspection.snapshotRoot !== snapshotRoot) {
    throw new TypeError("Inspection does not match Knip snapshot");
  }
  const registry = await captureSnapshotRegistry(snapshotRoot);
  const workspaces: Record<
    string,
    {
      entry: readonly string[];
      project: readonly string[];
      ignore: readonly string[];
    }
  > = {};
  for (const workspace of inspection.workspaces) {
    const manifest = record(
      await readJsonData(registry, workspace.manifestPath),
    );
    const declaredEntries = entrypointStrings(manifest)
      .map((path) => workspacePath(workspace, path))
      .filter((path) => registry.resolve(path)?.targetKind === "file")
      .map((path) => relativeToWorkspace(workspace, path));
    const sourceEntries = workspace.sourceFiles
      .filter((path) => /(^|\/)src\/index\.(?:[cm]?[jt]sx?)$/iu.test(path))
      .map((path) => relativeToWorkspace(workspace, path));
    const project = workspace.sourceFiles
      .map((path) => relativeToWorkspace(workspace, path))
      .sort(compareCodeUnits);
    const entry = [...new Set([...declaredEntries, ...sourceEntries])].sort(
      compareCodeUnits,
    );
    workspaces[workspace.relativeRoot] = {
      entry,
      project,
      ignore: [...IGNORE],
    };
  }
  return Object.freeze({
    ...(await disabledPinnedPlugins()),
    include: Object.freeze([...ISSUE_TYPES]),
    ignore: Object.freeze([...IGNORE]),
    workspaces: Object.freeze(workspaces),
  });
}
