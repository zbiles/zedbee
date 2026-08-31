import { posix, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { parse, type ParseError } from "jsonc-parser";
import picomatch from "picomatch";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  type SnapshotRegistry,
} from "../../inspection/snapshot-registry.js";
import type { WorkspaceInspection } from "../../inspection/types.js";
import type { SnapshotProgramInput } from "./compiler-host.js";

const SOURCE = /\.(?:[cm]?[jt]sx?)$/iu;
const LOADABLE = /(?:\.(?:[cm]?[jt]sx?|json))$/iu;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

function normalize(path: string): string {
  return path.split(sep).join("/");
}

function containedRepositoryPath(from: string, requested: string): string {
  if (
    requested.length === 0 ||
    requested.includes("\\") ||
    WINDOWS_DRIVE_PATH.test(requested) ||
    URL_SCHEME.test(requested) ||
    posix.isAbsolute(requested)
  ) {
    throw new TypeError("Unsafe TypeScript configuration path");
  }
  const result = posix.normalize(posix.join(posix.dirname(from), requested));
  if (result === ".." || result.startsWith("../")) {
    throw new TypeError("Unsafe TypeScript configuration path");
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid TypeScript configuration");
  }
  return value as Record<string, unknown>;
}

function stringList(configPath: string, value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError("Invalid TypeScript configuration path list");
  }
  for (const item of value as string[]) {
    containedRepositoryPath(configPath, item.replaceAll("*", "placeholder"));
  }
}

function validateConfigPaths(configPath: string, value: unknown): void {
  const config = record(value);
  for (const field of ["files", "include", "exclude"] as const) {
    stringList(configPath, config[field]);
  }
  const extension = config.extends;
  if (extension !== undefined) {
    const values = Array.isArray(extension) ? extension : [extension];
    if (values.some((item) => typeof item !== "string")) {
      throw new TypeError("Invalid TypeScript configuration extension");
    }
    for (const item of values as string[]) {
      if (!item.startsWith(".")) {
        throw new TypeError("Package TypeScript configuration is not allowed");
      }
      containedRepositoryPath(configPath, item);
    }
  }
  if (config.references !== undefined) {
    if (!Array.isArray(config.references)) {
      throw new TypeError("Invalid TypeScript project references");
    }
    for (const reference of config.references) {
      const path = record(reference).path;
      if (typeof path !== "string") {
        throw new TypeError("Invalid TypeScript project reference");
      }
      containedRepositoryPath(configPath, path);
    }
  }
  if (config.compilerOptions === undefined) return;
  const options = record(config.compilerOptions);
  for (const field of [
    "baseUrl",
    "rootDir",
    "outDir",
    "declarationDir",
    "tsBuildInfoFile",
    "outFile",
  ] as const) {
    const path = options[field];
    if (path === undefined) continue;
    if (typeof path !== "string")
      throw new TypeError("Invalid TypeScript path");
    containedRepositoryPath(configPath, path);
  }
  stringList(configPath, options.typeRoots);
  stringList(configPath, options.rootDirs);
  if (options.paths !== undefined) {
    for (const substitutions of Object.values(record(options.paths))) {
      stringList(configPath, substitutions);
    }
  }
}

function preferredConfig(workspace: WorkspaceInspection): string {
  const expected =
    workspace.relativeRoot === "."
      ? "tsconfig.json"
      : `${workspace.relativeRoot}/tsconfig.json`;
  return (
    workspace.tsconfigPaths.find((path) => path === expected) ??
    workspace.tsconfigPaths[0] ??
    expected
  );
}

function configHost(
  snapshotRoot: string,
  files: ReadonlyMap<string, string>,
): ts.ParseConfigHost {
  const pathMatcher = (pattern: string): ((path: string) => boolean) => {
    const normalized = pattern.replace(/\/+$/u, "");
    const exact = picomatch(pattern, { dot: true });
    const descendant = picomatch(`${normalized}/**/*`, { dot: true });
    return (path) => exact(path) || descendant(path);
  };
  return {
    useCaseSensitiveFileNames: true,
    fileExists: (path) => files.has(resolve(path)),
    readFile: (path) => files.get(resolve(path)),
    readDirectory(rootDir, extensions, excludes, includes, depth) {
      const root = resolve(rootDir);
      const include = (includes?.length ? includes : ["**/*"]).map(pathMatcher);
      const exclude = (excludes ?? []).map(pathMatcher);
      return [...files.keys()].filter((path) => {
        const fromRoot = normalize(relative(root, path));
        if (
          fromRoot === ".." ||
          fromRoot.startsWith("../") ||
          (depth !== undefined && fromRoot.split("/").length - 1 > depth) ||
          !extensions.some((extension) => path.endsWith(extension))
        ) {
          return false;
        }
        return (
          include.some((match) => match(fromRoot)) &&
          !exclude.some((match) => match(fromRoot))
        );
      });
    },
    trace: () => undefined,
  };
}

async function readConfigGraph(
  registry: SnapshotRegistry,
  configPath: string,
  loaded: Map<string, string>,
  seen = new Set<string>(),
): Promise<void> {
  if (seen.has(configPath)) return;
  seen.add(configPath);
  const source = await readContainedFile(registry, configPath);
  loaded.set(resolve(registry.snapshotRoot, ...configPath.split("/")), source);
  const errors: ParseError[] = [];
  const data = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0)
    throw new TypeError("Malformed TypeScript configuration");
  validateConfigPaths(configPath, data);
  const config = record(data);
  const extensions =
    config.extends === undefined
      ? []
      : Array.isArray(config.extends)
        ? config.extends
        : [config.extends];
  for (const extension of extensions as string[]) {
    const base = containedRepositoryPath(configPath, extension);
    const candidates = [
      base,
      `${base}.json`,
      posix.join(base, "tsconfig.json"),
    ];
    const resolvedPath = candidates.find(
      (candidate) => registry.resolve(candidate)?.targetKind === "file",
    );
    if (resolvedPath === undefined)
      throw new TypeError("Unavailable TypeScript configuration");
    await readConfigGraph(registry, resolvedPath, loaded, seen);
  }
  for (const reference of (config.references ?? []) as Record<
    string,
    unknown
  >[]) {
    const base = containedRepositoryPath(configPath, reference.path as string);
    const candidates = [
      base,
      `${base}.json`,
      posix.join(base, "tsconfig.json"),
    ];
    const resolvedPath = candidates.find(
      (candidate) => registry.resolve(candidate)?.targetKind === "file",
    );
    if (resolvedPath === undefined)
      throw new TypeError("Unavailable TypeScript project reference");
    await readConfigGraph(registry, resolvedPath, loaded, seen);
  }
}

export async function loadSnapshotProgramInput(
  snapshotRoot: string,
  repositoryRoot: string,
  workspace: WorkspaceInspection,
): Promise<SnapshotProgramInput> {
  const prepared = await prepareSnapshotProgramFiles(snapshotRoot);
  return programInputForConfig(
    prepared,
    repositoryRoot,
    workspace,
    preferredConfig(workspace),
    true,
  );
}

export interface SnapshotProgramProject {
  readonly configPath: string;
  readonly input: SnapshotProgramInput;
}

interface PreparedSnapshotProgramFiles {
  readonly canonicalRoot: string;
  readonly registry: SnapshotRegistry;
  readonly files: Map<string, string>;
}

async function prepareSnapshotProgramFiles(
  snapshotRoot: string,
): Promise<PreparedSnapshotProgramFiles> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  const registry = await captureSnapshotRegistry(canonicalRoot);
  const files = new Map<string, string>();
  for (const entry of registry.entries()) {
    if (entry.targetKind !== "file" || !LOADABLE.test(entry.repositoryPath))
      continue;
    files.set(
      entry.absolutePath,
      await readContainedFile(registry, entry.repositoryPath),
    );
  }
  return { canonicalRoot, registry, files };
}

async function programInputForConfig(
  prepared: PreparedSnapshotProgramFiles,
  repositoryRoot: string,
  workspace: WorkspaceInspection,
  configPath: string,
  fallbackToWorkspace: boolean,
): Promise<SnapshotProgramInput> {
  const { canonicalRoot, registry, files } = prepared;
  if (registry.resolve(configPath)?.targetKind !== "file") {
    throw new TypeError("Missing TypeScript configuration");
  }
  await readConfigGraph(registry, configPath, files);
  const configAbsolute = resolve(canonicalRoot, ...configPath.split("/"));
  const parsedText = ts.parseConfigFileTextToJson(
    configAbsolute,
    files.get(configAbsolute) ?? "",
  );
  if (parsedText.error !== undefined || parsedText.config === undefined) {
    throw new TypeError("Malformed TypeScript configuration");
  }
  const parsed = ts.parseJsonConfigFileContent(
    parsedText.config,
    configHost(canonicalRoot, files),
    resolve(configAbsolute, ".."),
    undefined,
    configAbsolute,
  );
  if (parsed.errors.length > 0) {
    const codes = [...new Set(parsed.errors.map(({ code }) => code))].sort(
      (left, right) => left - right,
    );
    throw new TypeError(
      `Invalid TypeScript configuration (${codes.join(",")})`,
    );
  }
  const allowedRoots = new Set(
    workspace.sourceFiles.filter((path) => SOURCE.test(path)),
  );
  const parsedRoots = parsed.fileNames
    .map((path) => normalize(relative(canonicalRoot, path)))
    .filter((path) => allowedRoots.has(path));
  const rootNames =
    parsedRoots.length > 0 || !fallbackToWorkspace
      ? parsedRoots
      : [...allowedRoots];
  if (
    rootNames.length === 0 &&
    (parsed.projectReferences === undefined ||
      parsed.projectReferences.length === 0)
  ) {
    throw new TypeError("No TypeScript source files");
  }
  const sources: Record<string, string> = {};
  for (const [absolute, source] of files) {
    const path = normalize(relative(canonicalRoot, absolute));
    if (path !== ".." && !path.startsWith("../")) sources[path] = source;
  }
  return {
    repositoryRoot,
    snapshotRoot: canonicalRoot,
    files: sources,
    rootNames,
    options: parsed.options,
    ...(parsed.projectReferences === undefined
      ? {}
      : { projectReferences: parsed.projectReferences }),
  };
}

/** Loads every contained TypeScript project without inventing file coverage. */
export async function loadSnapshotProgramProjects(
  snapshotRoot: string,
  repositoryRoot: string,
  workspace: WorkspaceInspection,
): Promise<readonly SnapshotProgramProject[]> {
  const prepared = await prepareSnapshotProgramFiles(snapshotRoot);
  const preferred = preferredConfig(workspace);
  const configPaths = [
    preferred,
    ...workspace.tsconfigPaths.filter((path) => path !== preferred),
  ];
  if (configPaths.length === 0)
    throw new TypeError("Missing TypeScript configuration");
  const projects: SnapshotProgramProject[] = [];
  const referencedConfigs = new Set<string>();
  for (const configPath of configPaths) {
    if (referencedConfigs.has(configPath)) continue;
    try {
      const input = await programInputForConfig(
        prepared,
        repositoryRoot,
        workspace,
        configPath,
        false,
      );
      projects.push({
        configPath,
        input,
      });
      for (const reference of input.projectReferences ?? []) {
        const path = normalize(
          relative(prepared.canonicalRoot, reference.path),
        );
        referencedConfigs.add(
          path.endsWith(".json") ? path : posix.join(path, "tsconfig.json"),
        );
      }
    } catch (error) {
      if (
        error instanceof TypeError &&
        error.message === "No TypeScript source files"
      ) {
        continue;
      }
      throw error;
    }
  }
  if (projects.length === 0) throw new TypeError("No TypeScript projects");
  return Object.freeze(projects);
}
