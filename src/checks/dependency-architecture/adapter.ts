import { packageExportTargetsForConditions } from "../package-export-targets.js";
import {
  isContainedImportSpecifier,
  WINDOWS_PATH,
  URL_SCHEME,
} from "../project/import-specifier.js";
import { findWorkspace } from "../../inspection/workspaces.js";
import { owningWorkspace } from "../../inspection/workspace-owner.js";
import {
  prepareSnapshotAliases,
  normalizedAliasSpecifier,
  type PreparedSnapshotAliases,
} from "../typescript/aliases.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import { inspectManagedCheck } from "../applicability.js";
import { projectInputsMayHaveChanged } from "../project-inputs.js";
import { join, posix, relative, resolve, sep } from "node:path";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import {
  canonicalizeSnapshotRoot,
  readJsonData,
} from "../../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  type SnapshotRegistry,
} from "../../inspection/snapshot-registry.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import type {
  CheckObservationSet,
  CheckRunContext,
  CheckTarget,
  ObservationCheckAdapter,
} from "../adapter.js";
import { normalizeDependencyViolations } from "./normalize-graph.js";
import { createManagedDependencyRules } from "./rules.js";
import { loadSnapshotProgramInput } from "../typescript/config.js";
import { COMPILER_SOURCE } from "../compiler-paths.js";

const GENERATED = "(^|/)(?:node_modules|dist|build|coverage|vendor)(?:/|$)";
const UNSAFE_RESOLUTION = "^(?:\\.\\.(?:/|$)|/|[A-Za-z]:[/\\\\])";

function validateSpecifier(sourcePath: string, specifier: string): void {
  if (!isContainedImportSpecifier(sourcePath, specifier))
    throw new TypeError("Dependency import escaped the snapshot");
}

function validateContainedImports(
  registry: SnapshotRegistry,
  specifiers: readonly (readonly [string, string])[],
): void {
  // Dependency-cruiser uses native reads; its entire input tree must be safe.
  for (const [path] of registry.unavailableSymlinks ?? []) {
    throw new CheckIncompleteError({
      code: "DEPENDENCY_ARCHITECTURE_UNSAFE_LINK",
      message:
        "Dependency architecture analysis cannot safely resolve this symbolic link.",
      path,
      remediation:
        "Provide a link to a tracked target inside the repository or remove the runtime link from the selected snapshot, then retry.",
    });
  }
  for (const [sourcePath, specifier] of specifiers)
    validateSpecifier(sourcePath, specifier);
}

function validateContainedGraph(result: ICruiseResult): void {
  const unsafe = (path: string): boolean =>
    path === ".." ||
    path.startsWith("../") ||
    posix.isAbsolute(path) ||
    WINDOWS_PATH.test(path);
  for (const module of result.modules) {
    if (unsafe(module.source.replaceAll("\\", "/"))) {
      throw new TypeError("Dependency graph escaped the snapshot");
    }
    for (const dependency of module.dependencies) {
      if (unsafe(dependency.resolved.replaceAll("\\", "/"))) {
        throw new TypeError("Dependency graph escaped the snapshot");
      }
    }
  }
}

function entrypointRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid workspace package entrypoints");
  }
  return value as Record<string, unknown>;
}

// Match dependency-cruiser's shared resolver conditions rather than
// treating every package condition as an unconditional alias.
const GRAPH_CONDITIONS = [
  "import",
  "require",
  "node",
  "default",
  "types",
] as const;
const graphConditions = new Set<string>(GRAPH_CONDITIONS);
function manifestEntrypoints(
  value: unknown,
): ReadonlyMap<string, readonly (string | null)[]> {
  const manifest = entrypointRecord(value);
  const result = new Map<string, readonly (string | null)[]>();
  const exportsValue = manifest.exports;
  if (exportsValue !== undefined) {
    if (
      typeof exportsValue === "object" &&
      exportsValue !== null &&
      !Array.isArray(exportsValue) &&
      Object.keys(exportsValue).some((key) => key.startsWith("."))
    ) {
      const exportsRecord = exportsValue as Record<string, unknown>;
      for (const key of Object.keys(exportsRecord).sort(compareCodeUnits)) {
        if (key === "." || (/^\.\/[^*]+$/u.test(key) && !key.includes(".."))) {
          result.set(
            key,
            packageExportTargetsForConditions(
              exportsRecord[key],
              graphConditions,
            ),
          );
        }
      }
    } else {
      result.set(
        ".",
        packageExportTargetsForConditions(exportsValue, graphConditions),
      );
    }
  }
  const legacy = [manifest.module, manifest.main, manifest.types].filter(
    (candidate): candidate is string => typeof candidate === "string",
  );
  if (exportsValue === undefined && legacy.length > 0) {
    result.set(".", [...(result.get(".") ?? []), ...legacy]);
  }
  return result;
}

const ENTRY_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

function containedEntrypoint(
  workspace: WorkspaceInspection,
  sourceFiles: ReadonlySet<string>,
  target: string,
): string | undefined {
  if (
    target.length === 0 ||
    target.includes("\\") ||
    posix.isAbsolute(target) ||
    WINDOWS_PATH.test(target) ||
    URL_SCHEME.test(target)
  ) {
    throw new TypeError("Workspace entrypoint escaped the snapshot");
  }
  const root = workspace.relativeRoot === "." ? "" : workspace.relativeRoot;
  const stripped = target.replace(/^\.\//u, "");
  const base = posix.normalize(posix.join(root, stripped));
  if (base === ".." || base.startsWith("../")) {
    throw new TypeError("Workspace entrypoint escaped the snapshot");
  }
  const candidates = new Set<string>([
    base,
    base.replace(/(^|\/)dist\//u, "$1src/"),
  ]);
  for (const candidate of [...candidates]) {
    const withoutExtension = candidate.replace(
      /\.(?:[cm]?js|jsx|d\.ts)$/iu,
      "",
    );
    for (const extension of ENTRY_EXTENSIONS) {
      candidates.add(`${withoutExtension}${extension}`);
      candidates.add(`${candidate}/index${extension}`);
    }
  }
  return [...candidates].find((candidate) => sourceFiles.has(candidate));
}

function workspaceAliasEntries(
  workspace: WorkspaceInspection,
  name: string,
  manifest: Record<string, unknown>,
  snapshotRoot: string,
): readonly (readonly [string, string])[] {
  const entries: (readonly [string, string])[] = [];
  const sourceFiles = new Set(workspace.sourceFiles);
  const entrypoints = manifestEntrypoints(manifest);
  const root =
    workspace.relativeRoot === "." ? "" : `${workspace.relativeRoot}/`;
  const rootFallbacks = [
    ...ENTRY_EXTENSIONS.flatMap((extension) => [
      `${root}src/index${extension}`,
      `${root}src/main${extension}`,
      `${root}index${extension}`,
    ]),
    ...(workspace.sourceFiles.length === 1 ? workspace.sourceFiles : []),
  ];
  for (const exportKey of [".", ...entrypoints.keys()].sort(compareCodeUnits)) {
    const entry =
      (entrypoints.get(exportKey) ?? [])
        .filter((target): target is string => target !== null)
        .map((target) => containedEntrypoint(workspace, sourceFiles, target))
        .find((candidate) => candidate !== undefined) ??
      (exportKey === "." && manifest.exports === undefined
        ? rootFallbacks.find((candidate) => sourceFiles.has(candidate))
        : undefined);
    if (entry === undefined) continue;
    const specifier =
      exportKey === "." ? name : `${name}/${exportKey.slice(2)}`;
    entries.push([`${specifier}$`, join(snapshotRoot, entry)]);
  }
  return entries;
}

async function workspaceAliases(
  inspection: RepositoryInspection,
  snapshotRoot: string,
  registry: SnapshotRegistry,
): Promise<Readonly<Record<string, string>>> {
  const named = inspection.workspaces.flatMap((workspace) =>
    workspace.name === undefined ? [] : [{ workspace, name: workspace.name }],
  );
  const loaded = await Promise.all(
    named.map(async ({ workspace, name }) => ({
      workspace,
      name,
      manifest: entrypointRecord(
        await readJsonData(registry, workspace.manifestPath),
      ),
    })),
  );
  const aliases: Record<string, string> = {};
  for (const { workspace, name, manifest } of loaded) {
    for (const [key, value] of workspaceAliasEntries(
      workspace,
      name,
      manifest,
      snapshotRoot,
    ))
      aliases[key] = value;
  }
  return aliases;
}

/** Most specific workspace root first; the repository root "." last. */
function compareScopeRoots(left: string, right: string): number {
  return (
    Number(left === ".") - Number(right === ".") || right.length - left.length
  );
}

/** Redirect only to pre-resolved captured files, scoped to the importing workspace. */
function capturedAliasPlugin(
  snapshotRoot: string,
  prepared: PreparedSnapshotAliases,
): Extract<
  NonNullable<NonNullable<Parameters<typeof cruise>[2]>["plugins"]>[number],
  { apply: unknown }
> {
  const scopes = [...prepared.workspaces.keys()].sort(compareScopeRoots);
  return {
    apply(resolver) {
      const target = resolver.ensureHook("resolve");
      resolver
        .getHook("resolve")
        .tapAsync(
          { name: "ZedbeeSnapshotAliases", stage: -100 },
          (request, context, callback) => {
            if (request.request === undefined || request.path === false)
              return callback();
            const path = relative(snapshotRoot, resolve(request.path))
              .split(sep)
              .join("/");
            const scope = scopes.find(
              (root) =>
                root === "." || path === root || path.startsWith(`${root}/`),
            );
            const specifier = normalizedAliasSpecifier(request.request);
            const file =
              scope === undefined
                ? undefined
                : (prepared.paths.get(scope)?.[specifier]?.[0] ??
                  prepared.workspaces
                    .get(scope)
                    ?.resolve(
                      posix.join(path, ".zedbee-resolution.ts"),
                      specifier,
                    ));
            if (file === undefined) return callback();
            return resolver.doResolve(
              target,
              { ...request, request: join(snapshotRoot, file) },
              "captured TypeScript alias",
              context,
              callback,
            );
          },
        );
    },
  };
}

function resultObject(output: ICruiseResult | string): ICruiseResult {
  const parsed =
    typeof output === "string" ? (JSON.parse(output) as unknown) : output;
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("Expected dependency-cruiser output");
  }
  return parsed as ICruiseResult;
}

async function collectSide(
  snapshotRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
  signal: AbortSignal,
  baselineWorkspacePackages: readonly string[] = [],
): Promise<readonly Observation[]> {
  signal.throwIfAborted();
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (canonicalRoot !== inspection.snapshotRoot) {
    throw new Error("Dependency architecture analysis failed.", {
      cause: new Error(
        "Snapshot root does not match the inspected repository root.",
      ),
    });
  }
  const workspace = findWorkspace(inspection, target.relativeRoot);
  if (workspace === undefined) return Object.freeze([]);
  const sourceFiles = workspace.sourceFiles
    .filter((path) => COMPILER_SOURCE.test(path))
    .sort(compareCodeUnits);
  if (sourceFiles.length === 0) return Object.freeze([]);
  const specifiers: (readonly [string, string])[] = [];
  const registry = await captureSnapshotRegistry(canonicalRoot);
  const aliases = await prepareSnapshotAliases(
    canonicalRoot,
    inspection,
    workspace,
    undefined,
    {
      registry,
      onSpecifier: (sourcePath, specifier) => {
        specifiers.push([sourcePath, specifier]);
      },
    },
  );
  validateContainedImports(registry, specifiers);
  const programInput =
    workspace.tsconfigPaths.length === 0
      ? undefined
      : await loadSnapshotProgramInput(canonicalRoot, canonicalRoot, workspace);
  const run = await cruise(
    sourceFiles,
    {
      validate: true,
      ruleSet: createManagedDependencyRules(),
      outputType: "json",
      baseDir: canonicalRoot,
      exclude: GENERATED,
      doNotFollow: { path: UNSAFE_RESOLUTION },
      cache: false,
      progress: { type: "none" },
      tsPreCompilationDeps: "specify",
      preserveSymlinks: true,
    },
    {
      modules: [join(canonicalRoot, ".zedbee-unavailable-node-modules")],
      conditionNames: [...GRAPH_CONDITIONS],
      bustTheCache: true,
      alias: await workspaceAliases(inspection, canonicalRoot, registry),
      plugins: [capturedAliasPlugin(canonicalRoot, aliases)],
    },
    programInput === undefined
      ? undefined
      : { tsConfig: { options: programInput.options } },
  );
  signal.throwIfAborted();
  if (run.exitCode !== 0 && run.exitCode !== 1) {
    throw new Error("Dependency architecture analysis failed.", {
      cause: new Error(`dependency-cruiser exited with code ${run.exitCode}.`),
    });
  }
  const result = resultObject(run.output);
  validateContainedGraph(result);
  const issues = result.summary.environment.issues ?? [];
  if (issues.length > 0) {
    throw new Error("Dependency architecture analysis failed.", {
      cause: new Error(
        `dependency-cruiser reported environment issues: ${issues
          .map(({ name }) => name)
          .join(", ")}.`,
      ),
    });
  }
  const aliasConfigPath = aliases.workspaces.get(
    workspace.relativeRoot,
  )?.configPath;
  return normalizeDependencyViolations(
    result,
    canonicalRoot,
    new Set(sourceFiles),
    {
      production: new Set(workspace.productionDependencies ?? []),
      development: new Set(workspace.developmentDependencies ?? []),
      aliases: Object.keys(programInput?.options.paths ?? {}).sort(
        compareCodeUnits,
      ),
      ...(aliasConfigPath === undefined ? {} : { aliasConfigPath }),
      localAliasSpecifiers: new Set(
        Object.entries(aliases.paths.get(workspace.relativeRoot) ?? {})
          .filter(([, targets]) =>
            targets.some(
              (path) =>
                owningWorkspace(inspection.workspaces, path)?.relativeRoot ===
                workspace.relativeRoot,
            ),
          )
          .map(([specifier]) => specifier),
      ),
      workspacePackages: new Set([
        ...baselineWorkspacePackages,
        ...inspection.workspaces
          .map(({ name }) => name)
          .filter((name): name is string => name !== undefined),
      ]),
    },
  );
}

export const dependencyArchitectureAdapter: ObservationCheckAdapter = {
  id: "dependencyArchitecture",
  output: "observations",
  inspect: (context: import("../adapter.js").InspectionContext) =>
    inspectManagedCheck("dependencyArchitecture", context),
  async collect(context: CheckRunContext): Promise<CheckObservationSet> {
    try {
      const baselineObservations = await collectSide(
        context.snapshots.baselineDir,
        context.baselineInspection,
        context.target,
        context.signal,
      );
      const targetObservations = await collectSide(
        context.snapshots.targetDir,
        context.targetInspection,
        context.target,
        context.signal,
        context.baselineInspection.workspaces.flatMap(({ name }) =>
          name === undefined ? [] : [name],
        ),
      );
      return {
        checkId: "dependencyArchitecture",
        target: context.target,
        baselineObservations,
        targetObservations,
        projectDelta: await projectInputsMayHaveChanged(
          context,
          context.target,
          "deletions",
        ),
      };
    } catch (error) {
      if (error instanceof CheckIncompleteError) throw error;
      throw new Error("Dependency architecture analysis failed.", {
        cause: error,
      });
    }
  },
};
