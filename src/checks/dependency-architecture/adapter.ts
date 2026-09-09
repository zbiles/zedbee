import { inspectManagedCheck } from "../applicability.js";
import { join, posix } from "node:path";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import ts from "typescript";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
  readJsonData,
} from "../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
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

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const GENERATED = "(^|/)(?:node_modules|dist|build|coverage|vendor)(?:/|$)";
const UNSAFE_RESOLUTION = "^(?:\\.\\.(?:/|$)|/|[A-Za-z]:[/\\\\])";
const WINDOWS_PATH = /^[A-Za-z]:[/\\]/u;
const URL = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

function workspaceFor(
  inspection: RepositoryInspection,
  target: CheckTarget,
): WorkspaceInspection | undefined {
  return inspection.workspaces.find(
    ({ relativeRoot }) => relativeRoot === target.relativeRoot,
  );
}

function selectedTsconfig(workspace: WorkspaceInspection): string | undefined {
  const sorted = [...workspace.tsconfigPaths].sort(
    (left, right) =>
      Number(right.endsWith("/tsconfig.json") || right === "tsconfig.json") -
        Number(left.endsWith("/tsconfig.json") || left === "tsconfig.json") ||
      compareCodeUnits(left, right),
  );
  return sorted[0];
}

function staticModuleSpecifier(node: ts.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]!) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    return node.arguments[0]!.text;
  }
  return undefined;
}

function validateSpecifier(sourcePath: string, specifier: string): void {
  if (
    specifier.includes("\\") ||
    posix.isAbsolute(specifier) ||
    WINDOWS_PATH.test(specifier) ||
    (URL.test(specifier) &&
      !specifier.startsWith("node:") &&
      !specifier.startsWith("bun:"))
  ) {
    throw new TypeError("Dependency import escaped the snapshot");
  }
  if (!specifier.startsWith(".")) return;
  const resolved = posix.normalize(
    posix.join(posix.dirname(sourcePath), specifier),
  );
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new TypeError("Dependency import escaped the snapshot");
  }
}

async function validateContainedImports(
  snapshotRoot: string,
  sourceFiles: readonly string[],
): Promise<void> {
  const registry = await captureSnapshotRegistry(snapshotRoot);
  for (const sourcePath of sourceFiles) {
    const source = await readContainedFile(registry, sourcePath);
    const file = ts.createSourceFile(
      sourcePath,
      source,
      ts.ScriptTarget.Latest,
      false,
      sourcePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      const specifier = staticModuleSpecifier(node);
      if (specifier !== undefined) validateSpecifier(sourcePath, specifier);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
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

function hasProjectInputDelta(
  context: CheckRunContext,
  target: CheckTarget,
): boolean {
  const workspaces = [
    ...context.baselineInspection.workspaces,
    ...context.targetInspection.workspaces,
  ].filter(({ relativeRoot }) => relativeRoot === target.relativeRoot);
  const structuralPaths = new Set(
    workspaces.flatMap((workspace) => [
      workspace.manifestPath,
      ...workspace.tsconfigPaths,
    ]),
  );
  return [...context.changeSet.files.values()].some(
    (file) =>
      structuralPaths.has(file.path) ||
      (file.status === "deleted" &&
        workspaces.some((workspace) =>
          workspace.sourceFiles.includes(file.path),
        )),
  );
}

function entrypointRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid workspace package entrypoints");
  }
  return value as Record<string, unknown>;
}

function exportTargets(value: unknown, depth = 0): readonly string[] {
  if (depth > 8) throw new TypeError("Workspace exports are too deeply nested");
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((candidate) => exportTargets(candidate, depth + 1));
  }
  const object = entrypointRecord(value);
  return Object.keys(object)
    .sort(compareCodeUnits)
    .flatMap((key) => exportTargets(object[key], depth + 1));
}

function manifestEntrypoints(
  value: unknown,
): ReadonlyMap<string, readonly string[]> {
  const manifest = entrypointRecord(value);
  const result = new Map<string, readonly string[]>();
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
          result.set(key, exportTargets(exportsRecord[key]));
        }
      }
    } else {
      result.set(".", exportTargets(exportsValue));
    }
  }
  const legacy = [manifest.module, manifest.main, manifest.types].filter(
    (candidate): candidate is string => typeof candidate === "string",
  );
  if (legacy.length > 0) {
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
  target: string,
): string | undefined {
  if (
    target.length === 0 ||
    target.includes("\\") ||
    posix.isAbsolute(target) ||
    WINDOWS_PATH.test(target) ||
    URL.test(target)
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
  return [...candidates].find((candidate) =>
    workspace.sourceFiles.includes(candidate),
  );
}

async function workspaceAliases(
  inspection: RepositoryInspection,
  snapshotRoot: string,
): Promise<Readonly<Record<string, string>>> {
  const registry = await captureSnapshotRegistry(snapshotRoot);
  const aliases: Record<string, string> = {};
  for (const workspace of inspection.workspaces) {
    if (workspace.name === undefined) continue;
    const entrypoints = manifestEntrypoints(
      await readJsonData(registry, workspace.manifestPath),
    );
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
    for (const exportKey of [".", ...entrypoints.keys()].sort(
      compareCodeUnits,
    )) {
      const entry =
        (entrypoints.get(exportKey) ?? [])
          .map((target) => containedEntrypoint(workspace, target))
          .find((candidate) => candidate !== undefined) ??
        (exportKey === "."
          ? rootFallbacks.find((candidate) =>
              workspace.sourceFiles.includes(candidate),
            )
          : undefined);
      if (entry === undefined) continue;
      const specifier =
        exportKey === "."
          ? workspace.name
          : `${workspace.name}/${exportKey.slice(2)}`;
      aliases[`${specifier}$`] = join(snapshotRoot, entry);
    }
  }
  return aliases;
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
): Promise<readonly Observation[]> {
  signal.throwIfAborted();
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (canonicalRoot !== inspection.snapshotRoot) {
    throw new Error("Dependency architecture analysis failed.");
  }
  const workspace = workspaceFor(inspection, target);
  if (workspace === undefined) return Object.freeze([]);
  const sourceFiles = workspace.sourceFiles
    .filter((path) => SOURCE.test(path))
    .sort(compareCodeUnits);
  if (sourceFiles.length === 0) return Object.freeze([]);
  await validateContainedImports(canonicalRoot, sourceFiles);
  const tsconfig = selectedTsconfig(workspace);
  const programInput =
    tsconfig === undefined
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
      bustTheCache: true,
      alias: await workspaceAliases(inspection, canonicalRoot),
    },
    programInput === undefined
      ? undefined
      : { tsConfig: { options: programInput.options } },
  );
  signal.throwIfAborted();
  if (run.exitCode !== 0 && run.exitCode !== 1) {
    throw new Error("Dependency architecture analysis failed.");
  }
  const result = resultObject(run.output);
  validateContainedGraph(result);
  if ((result.summary.environment.issues?.length ?? 0) > 0) {
    throw new Error("Dependency architecture analysis failed.");
  }
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
      workspacePackages: new Set(
        inspection.workspaces
          .map(({ name }) => name)
          .filter((name): name is string => name !== undefined),
      ),
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
      );
      return {
        checkId: "dependencyArchitecture",
        target: context.target,
        baselineObservations,
        targetObservations,
        projectDelta: hasProjectInputDelta(context, context.target),
      };
    } catch (error) {
      throw new Error("Dependency architecture analysis failed.", {
        cause: error,
      });
    }
  },
};
