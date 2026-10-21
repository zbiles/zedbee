import { posix, relative, resolve, sep } from "node:path";
import { lstat } from "node:fs/promises";
import * as ts from "typescript";
import { parse, type ParseError } from "jsonc-parser";
import picomatch from "picomatch";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  IGNORED_DIRECTORY_NAMES,
  type SnapshotRegistry,
} from "../../inspection/snapshot-registry.js";
import {
  capturedSourceInput,
  capturedSourcePaths,
  capturedSourceRegistry,
} from "../../inspection/source-capture.js";
import type { WorkspaceInspection } from "../../inspection/types.js";
import type { SnapshotProgramInput } from "./compiler-host.js";
import { analysisStore } from "../analysis-reuse.js";

/** Internal config failures retain only repository paths and numeric TS codes. */
export class SnapshotConfigurationError extends Error {
  readonly codes: readonly number[];
  constructor(
    readonly configPath: string,
    codes: readonly number[] = [],
  ) {
    super("Invalid TypeScript configuration");
    this.name = "SnapshotConfigurationError";
    this.codes = Object.freeze([...new Set(codes)].sort((a, b) => a - b));
  }
}

const preparedInputs = Symbol("validated snapshot compiler inputs");

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

function canonicalWorkspaceConfig(workspace: WorkspaceInspection): string {
  return workspace.relativeRoot === "."
    ? "tsconfig.json"
    : `${workspace.relativeRoot}/tsconfig.json`;
}

function preferredConfig(workspace: WorkspaceInspection): string {
  const expected = canonicalWorkspaceConfig(workspace);
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
  prepared: PreparedSnapshotProgramFiles,
  configPath: string,
  seen = new Set<string>(),
): Promise<void> {
  if (seen.has(configPath) || prepared.validatedConfigs.has(configPath)) return;
  seen.add(configPath);
  const { registry, files: loaded } = prepared;
  const absolute = resolve(registry.snapshotRoot, ...configPath.split("/"));
  const source =
    loaded.get(absolute) ?? (await readContainedFile(registry, configPath));
  loaded.set(absolute, source);
  const errors: ParseError[] = [];
  const data = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new SnapshotConfigurationError(configPath);
  try {
    validateConfigPaths(configPath, data);
  } catch {
    throw new SnapshotConfigurationError(configPath);
  }
  const config = record(data);
  if (
    config.files !== undefined ||
    config.include !== undefined ||
    (Array.isArray(config.references) && config.references.length > 0)
  ) {
    prepared.explicitProjects.add(configPath);
  }
  const optionErrors = ts.convertCompilerOptionsFromJson(
    config.compilerOptions ?? {},
    resolve(registry.snapshotRoot, posix.dirname(configPath)),
    configPath,
  ).errors;
  if (optionErrors.length > 0)
    throw new SnapshotConfigurationError(
      configPath,
      optionErrors.map(({ code }) => code),
    );
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
      throw new SnapshotConfigurationError(configPath, [5083]);
    prepared.extendedConfigs.add(resolvedPath);
    await readConfigGraph(prepared, resolvedPath, seen);
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
      throw new SnapshotConfigurationError(configPath, [5083]);
    prepared.referencedConfigs.add(resolvedPath);
    await readConfigGraph(prepared, resolvedPath, seen);
  }
  prepared.validatedConfigs.add(configPath);
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
  sources: Readonly<Record<string, string>>;
  readonly parsedConfigs: Map<string, Promise<ts.ParsedCommandLine>>;
  readonly extendedConfigs: Set<string>;
  readonly explicitProjects: Set<string>;
  readonly referencedConfigs: Set<string>;
  readonly validatedConfigs: Set<string>;
}

interface PendingSnapshotProgramFiles {
  readonly capture: SnapshotRegistry | undefined;
  readonly pending: Promise<PreparedSnapshotProgramFiles>;
}

interface CachedSnapshotProgramFiles {
  readonly prepared: PreparedSnapshotProgramFiles;
  readonly capture: SnapshotRegistry | undefined;
  readonly metadata: ReadonlyMap<string, string>;
}

async function metadataFor(
  registry: SnapshotRegistry,
): Promise<Map<string, string>> {
  const metadata = new Map<string, string>();
  for (const entry of registry.entries()) {
    // Captured bytes/absence belong to their immutable source owner. Live
    // directories and links still validate inventory and containment changes.
    if (
      entry.kind === "file" &&
      capturedSourceInput(registry.snapshotRoot, entry.repositoryPath) !==
        undefined
    )
      continue;
    const value = await lstat(entry.absolutePath, { bigint: true });
    metadata.set(
      entry.absolutePath,
      `${value.dev}:${value.ino}:${value.mode}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`,
    );
  }
  return metadata;
}

function equalMetadata(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([path, value]) => right.get(path) === value)
  );
}

async function prepareSnapshotProgramFiles(
  snapshotRoot: string,
): Promise<PreparedSnapshotProgramFiles> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  const store = analysisStore<
    CachedSnapshotProgramFiles | PendingSnapshotProgramFiles
  >(preparedInputs);
  const capture = capturedSourceRegistry(canonicalRoot, []);
  const cached = store?.get(canonicalRoot);
  if (cached !== undefined && cached.capture === capture) {
    if ("pending" in cached) return cached.pending;
    try {
      if (
        equalMetadata(
          cached.metadata,
          await metadataFor(cached.prepared.registry),
        )
      )
        return cached.prepared;
    } catch {
      // Reacquisition applies the normal containment/read error boundary.
    }
  }
  store?.delete(canonicalRoot);
  const acquisition = acquireSnapshotProgramFiles(
    canonicalRoot,
    store !== undefined,
  );
  const entry: PendingSnapshotProgramFiles = {
    capture,
    pending: acquisition.then(({ prepared }) => prepared),
  };
  // Install the promise before the first filesystem await finishes. Concurrent
  // workspaces share acquisition; a rejected or closed owner retains nothing.
  store?.set(canonicalRoot, entry, 512);
  try {
    const { prepared, metadata, bytes } = await acquisition;
    if (store?.get(canonicalRoot) === entry) {
      store.delete(canonicalRoot);
      if (metadata !== undefined)
        store.set(canonicalRoot, { prepared, capture, metadata }, bytes);
    }
    return prepared;
  } catch (error) {
    // The returned pending promise is observed by concurrent callers only.
    await entry.pending.catch(() => undefined);
    if (store?.get(canonicalRoot) === entry) store.delete(canonicalRoot);
    throw error;
  }
}

async function acquireSnapshotProgramFiles(
  canonicalRoot: string,
  reusable: boolean,
): Promise<{
  readonly prepared: PreparedSnapshotProgramFiles;
  readonly metadata: ReadonlyMap<string, string> | undefined;
  readonly bytes: number;
}> {
  const registry = await captureSnapshotRegistry(canonicalRoot);
  const before = reusable ? await metadataFor(registry) : undefined;
  const files = new Map<string, string>();
  for (const entry of registry.entries()) {
    if (entry.targetKind !== "file" || !LOADABLE.test(entry.repositoryPath))
      continue;
    const captured = capturedSourceInput(canonicalRoot, entry.repositoryPath);
    if (captured !== undefined && captured.text === undefined) continue;
    files.set(
      entry.absolutePath,
      await readContainedFile(registry, entry.repositoryPath),
    );
  }
  // Keep the complete live inventory for unselected/config inputs. Selected
  // source files remain part of their explicit view even if removed on disk.
  for (const path of capturedSourcePaths(canonicalRoot)) {
    if (
      !SOURCE.test(path) ||
      path
        .split("/")
        .some((part) =>
          (IGNORED_DIRECTORY_NAMES as readonly string[]).includes(part),
        )
    )
      continue;
    const captured = capturedSourceInput(canonicalRoot, path)!;
    const absolutePath = resolve(canonicalRoot, path);
    if (captured.text === undefined) files.delete(absolutePath);
    else files.set(absolutePath, captured.text);
  }
  const sources: Record<string, string> = {};
  for (const [absolute, source] of files) {
    const path = normalize(relative(canonicalRoot, absolute));
    if (path !== ".." && !path.startsWith("../")) sources[path] = source;
  }
  const prepared = {
    canonicalRoot,
    registry,
    files,
    sources: Object.freeze(sources),
    parsedConfigs: new Map<string, Promise<ts.ParsedCommandLine>>(),
    extendedConfigs: new Set<string>(),
    explicitProjects: new Set<string>(),
    referencedConfigs: new Set<string>(),
    validatedConfigs: new Set<string>(),
  };
  const metadata =
    before !== undefined && equalMetadata(before, await metadataFor(registry))
      ? before
      : undefined;
  const bytes =
    [...files].reduce(
      (total, [path, text]) => total + path.length * 2 + text.length * 4 + 512,
      0,
    ) +
    (before?.size ?? 0) * 1024;
  return { prepared, metadata, bytes };
}

async function parsePreparedConfig(
  prepared: PreparedSnapshotProgramFiles,
  configPath: string,
): Promise<ts.ParsedCommandLine> {
  const { canonicalRoot, registry, files } = prepared;
  const size = files.size;
  await readConfigGraph(prepared, configPath);
  if (files.size !== size) {
    const sources = { ...prepared.sources };
    for (const [absolute, text] of files)
      sources[normalize(relative(canonicalRoot, absolute))] = text;
    prepared.sources = Object.freeze(sources);
  }
  const configAbsolute = resolve(canonicalRoot, ...configPath.split("/"));
  const parsedText = ts.parseConfigFileTextToJson(
    configAbsolute,
    files.get(configAbsolute) ?? "",
  );
  if (parsedText.error !== undefined || parsedText.config === undefined) {
    throw new SnapshotConfigurationError(
      configPath,
      parsedText.error === undefined ? [] : [parsedText.error.code],
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    parsedText.config,
    configHost(canonicalRoot, files),
    resolve(configAbsolute, ".."),
    undefined,
    configAbsolute,
  );
  // Empty project roots are a coverage decision for the requesting analyzer.
  // Never substitute workspace files for an explicit files/include/exclude.
  const errors = parsed.errors.filter(
    ({ code }) => code !== 18002 && code !== 18003,
  );
  if (errors.length > 0)
    throw new SnapshotConfigurationError(
      configPath,
      errors.map(({ code }) => code),
    );
  return parsed;
}

async function programInputForConfig(
  prepared: PreparedSnapshotProgramFiles,
  repositoryRoot: string,
  workspace: WorkspaceInspection,
  configPath: string,
): Promise<SnapshotProgramInput> {
  const { canonicalRoot, registry, files } = prepared;
  if (registry.resolve(configPath)?.targetKind !== "file") {
    throw new SnapshotConfigurationError(configPath, [5083]);
  }
  let parsing = prepared.parsedConfigs.get(configPath);
  if (parsing === undefined) {
    parsing = parsePreparedConfig(prepared, configPath);
    prepared.parsedConfigs.set(configPath, parsing);
  }
  let parsed: ts.ParsedCommandLine;
  try {
    parsed = await parsing;
  } catch (error) {
    if (prepared.parsedConfigs.get(configPath) === parsing)
      prepared.parsedConfigs.delete(configPath);
    throw error;
  }
  const allowedRoots = new Set(
    workspace.sourceFiles.filter((path) => SOURCE.test(path)),
  );
  const parsedRoots = parsed.fileNames
    .map((path) => normalize(relative(canonicalRoot, path)))
    .filter((path) => allowedRoots.has(path));
  const rootNames = parsedRoots;
  return {
    repositoryRoot,
    snapshotRoot: canonicalRoot,
    files: prepared.sources,
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
  const preferred = canonicalWorkspaceConfig(workspace);
  const configPaths = workspace.tsconfigPaths.includes(preferred)
    ? [
        preferred,
        ...workspace.tsconfigPaths.filter((path) => path !== preferred),
      ]
    : [...workspace.tsconfigPaths];
  if (configPaths.length === 0)
    throw new SnapshotConfigurationError(preferred, [5083]);
  // First discover graph roles, including a base reached from a later sibling.
  // Only the canonical config or an explicit project declaration can promote
  // an inherited helper into an independent root. Sorted fallback order cannot
  // turn a compiler-options-only base's implicit include into file coverage.
  const inputs = new Map<string, SnapshotProgramInput>();
  for (const configPath of configPaths) {
    inputs.set(
      configPath,
      await programInputForConfig(
        prepared,
        repositoryRoot,
        workspace,
        configPath,
      ),
    );
  }
  const projects: SnapshotProgramProject[] = [];
  const referencedConfigs = new Set<string>();
  for (const configPath of configPaths) {
    if (
      configPath !== preferred &&
      prepared.extendedConfigs.has(configPath) &&
      !prepared.explicitProjects.has(configPath) &&
      !prepared.referencedConfigs.has(configPath)
    )
      continue;
    if (referencedConfigs.has(configPath)) continue;
    const input = inputs.get(configPath)!;
    projects.push({ configPath, input });
    for (const reference of input.projectReferences ?? []) {
      const path = normalize(relative(prepared.canonicalRoot, reference.path));
      referencedConfigs.add(
        path.endsWith(".json") ? path : posix.join(path, "tsconfig.json"),
      );
    }
  }
  if (projects.length === 0) throw new TypeError("No TypeScript projects");
  return Object.freeze(projects);
}
