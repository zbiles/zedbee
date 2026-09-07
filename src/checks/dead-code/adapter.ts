import { inspectManagedCheck } from "../applicability.js";
import { lstat } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { isAnalyzerWorker } from "../runner/context.js";
import { AnalyzerJobError, analyzerDiagnostic } from "../diagnostics.js";
import ts from "typescript";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
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
import { writeManagedJsonConfig } from "../project/config-boundary.js";
import { createManagedKnipConfig } from "./managed-config.js";
import { parseKnipReport } from "./parse-report.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const WINDOWS_PATH = /^[A-Za-z]:[/\\]/u;
const URL = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const INERT_TSCONFIG = ".zedbee-managed-no-tsconfig.json";

function workspaceFor(
  inspection: RepositoryInspection,
  target: CheckTarget,
): WorkspaceInspection | undefined {
  return inspection.workspaces.find(
    ({ relativeRoot }) => relativeRoot === target.relativeRoot,
  );
}

function cliPath(): string {
  const modulePath = fileURLToPath(import.meta.resolve("knip"));
  return join(dirname(modulePath), "..", "bin", "knip.js");
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
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]!) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) &&
        node.expression.text === "require") ||
      (ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "require" &&
        node.expression.name.text === "resolve"))
  ) {
    return node.arguments[0]!.text;
  }
  return undefined;
}

function packageName(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("#") ||
    isBuiltin(specifier)
  ) {
    return undefined;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : undefined
    : parts[0];
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
    throw new TypeError("Dead-code import escaped the snapshot");
  }
  if (!specifier.startsWith(".")) return;
  const resolved = posix.normalize(
    posix.join(posix.dirname(sourcePath), specifier),
  );
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new TypeError("Dead-code import escaped the snapshot");
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ((error as { readonly code?: unknown }).code === "ENOENT" ||
        (error as { readonly code?: unknown }).code === "ENOTDIR")
    ) {
      return;
    }
    throw error;
  }
  throw new TypeError("Dead-code dependency resolution escaped the snapshot");
}

async function validateAncestorResolution(
  snapshotRoot: string,
  sourcePath: string,
  specifier: string,
): Promise<void> {
  const name = packageName(specifier);
  if (name === undefined) return;
  let directory = dirname(join(snapshotRoot, sourcePath));
  while (true) {
    await assertMissing(join(directory, "node_modules", ...name.split("/")));
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

async function validateSnapshotInputs(
  snapshotRoot: string,
  workspace: WorkspaceInspection,
): Promise<void> {
  const registry = await captureSnapshotRegistry(snapshotRoot);
  if (registry.resolve(INERT_TSCONFIG) !== undefined) {
    throw new TypeError("Reserved managed Knip path is present");
  }
  for (const sourcePath of workspace.sourceFiles) {
    const source = await readContainedFile(registry, sourcePath);
    const file = ts.createSourceFile(
      sourcePath,
      source,
      ts.ScriptTarget.Latest,
      false,
      sourcePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      const specifier = staticModuleSpecifier(node);
      if (specifier !== undefined) {
        validateSpecifier(sourcePath, specifier);
        specifiers.push(specifier);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    const jsDocImports = source.matchAll(
      /\/\*[\s\S]*?import\(\s*['"]([^'"]+)['"]\s*\)[\s\S]*?\*\//gu,
    );
    for (const match of jsDocImports) {
      const specifier = match[1];
      if (specifier !== undefined) {
        validateSpecifier(sourcePath, specifier);
        specifiers.push(specifier);
      }
    }
    for (const specifier of specifiers) {
      await validateAncestorResolution(snapshotRoot, sourcePath, specifier);
    }
  }
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
    throw new TypeError("Inspection does not match Knip snapshot");
  }
  const workspace = workspaceFor(inspection, target);
  if (workspace === undefined) return Object.freeze([]);
  await validateSnapshotInputs(canonicalRoot, workspace);
  const managed = await writeManagedJsonConfig(
    "knip",
    await createManagedKnipConfig(canonicalRoot, inspection),
  );
  try {
    const result = await execa(
      process.execPath,
      [
        cliPath(),
        "--config",
        managed.path,
        "--directory",
        canonicalRoot,
        "--workspace",
        workspace.relativeRoot,
        "--tsConfig",
        INERT_TSCONFIG,
        "--reporter",
        "json",
        "--no-progress",
        "--no-config-hints",
        "--no-tag-hints",
        "--no-gitignore",
      ],
      {
        cwd: canonicalRoot,
        shell: false,
        reject: false,
        stdin: "ignore",
        forceKillAfterDelay: 2_000,
        killDescendants: !isAnalyzerWorker(),
        cancelSignal: signal,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { NO_COLOR: "1", FORCE_COLOR: "0" },
      },
    );
    signal.throwIfAborted();
    await validateSnapshotInputs(canonicalRoot, workspace);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error("Knip analysis failed", {
        cause: new AnalyzerJobError(
          analyzerDiagnostic(
            "deadCode",
            "collect",
            "abnormal-exit",
            result.exitCode,
            result.signal,
          ),
        ),
      });
    }
    let report: unknown;
    try {
      report = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new TypeError("Malformed Knip JSON report");
    }
    return parseKnipReport(
      report,
      new Set([...workspace.sourceFiles, workspace.manifestPath]),
    );
  } finally {
    await managed.cleanup();
  }
}

function hasProjectDelta(context: CheckRunContext): boolean {
  const workspaces = [
    ...context.baselineInspection.workspaces,
    ...context.targetInspection.workspaces,
  ].filter(({ relativeRoot }) => relativeRoot === context.target.relativeRoot);
  const owned = new Set(
    workspaces.flatMap((workspace) => [
      workspace.manifestPath,
      ...workspace.sourceFiles,
    ]),
  );
  return [...context.changeSet.files.keys()].some((path) => owned.has(path));
}

export const deadCodeAdapter: ObservationCheckAdapter = {
  id: "deadCode",
  output: "observations",
  inspect: (context: import("../adapter.js").InspectionContext) =>
    inspectManagedCheck("deadCode", context),
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
        checkId: "deadCode",
        target: context.target,
        baselineObservations,
        targetObservations,
        projectDelta: hasProjectDelta(context),
      };
    } catch (error) {
      throw new Error("Dead-code analysis failed.", { cause: error });
    }
  },
};
