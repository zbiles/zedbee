import { relative, sep } from "node:path";
import type * as ts from "typescript";
import type {
  CheckObservationSet,
  CheckRunContext,
  CheckTarget,
  ObservationCheckAdapter,
} from "../adapter.js";
import type { Observation } from "../../core/types.js";
import { compareCodeUnits } from "../../core/compare.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import { canonicalizeSnapshotRoot } from "../../inspection/read-json.js";
import { convertEslintMessage } from "./convert-message.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import { createManagedEslint } from "./load-engine.js";
import { createSnapshotProgram } from "../typescript/compiler-host.js";
import { loadSnapshotProgramInput } from "../typescript/config.js";

const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/u;
const JAVASCRIPT_SOURCE = /\.(?:js|jsx|mjs|cjs)$/u;

function sourceChanged(
  workspace: WorkspaceInspection,
  paths: ReadonlySet<string>,
): boolean {
  return workspace.sourceFiles.some((path) => paths.has(path));
}

function targetFor(workspace: WorkspaceInspection): CheckTarget {
  return {
    id: workspace.relativeRoot,
    kind: "workspace",
    relativeRoot: workspace.relativeRoot,
  };
}

function workspaceFor(
  inspection: RepositoryInspection,
  target: CheckTarget,
): WorkspaceInspection | undefined {
  return inspection.workspaces.find(
    (workspace) => workspace.relativeRoot === target.relativeRoot,
  );
}

async function collectSide(
  snapshotRoot: string,
  repositoryRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
): Promise<readonly Observation[]> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (canonicalRoot !== inspection.snapshotRoot) {
    throw new Error("Managed lint analysis failed.");
  }
  const workspace = workspaceFor(inspection, target);
  if (workspace === undefined) return Object.freeze([]);
  const files = workspace.sourceFiles
    .filter(
      (path) => JAVASCRIPT_SOURCE.test(path) || TYPESCRIPT_SOURCE.test(path),
    )
    .sort(compareCodeUnits);
  if (files.length === 0) return Object.freeze([]);
  const typescriptFiles = files.filter((path) => TYPESCRIPT_SOURCE.test(path));

  let typedProject: { readonly programs: readonly ts.Program[] } | undefined;
  if (typescriptFiles.length > 0) {
    try {
      const input = await loadSnapshotProgramInput(
        canonicalRoot,
        repositoryRoot,
        workspace,
      );
      const { programs } = createSnapshotProgram(input);
      typedProject = {
        programs,
      };
    } catch {
      throw new CheckIncompleteError({
        code: "TYPED_LINT_SETUP_FAILED",
        message:
          "Typed lint could not build a usable project from this workspace's TypeScript configuration.",
        remediation:
          "Verify that a staged tsconfig.json covers the staged TypeScript files and that referenced configurations are present, then retry.",
      });
    }
  }

  try {
    const engine = createManagedEslint({
      cwd: canonicalRoot,
      mode: "lint",
      managedIgnores: [],
      ...(typedProject === undefined ? {} : { typedProject }),
    });
    const results = await engine.lintFiles(files);
    const allowed = new Set(files);
    const observations: Observation[] = [];
    for (const result of results) {
      const path = relative(canonicalRoot, result.filePath)
        .split(sep)
        .join("/");
      if (!allowed.has(path))
        throw new TypeError("ESLint returned an unrequested file");
      if (
        TYPESCRIPT_SOURCE.test(path) &&
        result.messages.some(
          (message) =>
            message.fatal === true &&
            (!Number.isSafeInteger(message.line) || message.line < 1),
        )
      ) {
        throw new Error("Typed lint analysis failed.");
      }
      observations.push(
        ...result.messages.map((message) =>
          convertEslintMessage(path, message, canonicalRoot),
        ),
      );
    }
    return Object.freeze(
      observations.sort(
        (left, right) =>
          compareCodeUnits(left.identity, right.identity) ||
          compareCodeUnits(left.message, right.message),
      ),
    );
  } catch (error) {
    if (error instanceof CheckIncompleteError) throw error;
    if (
      error instanceof Error &&
      error.message === "Typed lint analysis failed."
    ) {
      throw new CheckIncompleteError({
        code: "TYPED_LINT_ANALYSIS_FAILED",
        message:
          "Typed lint could not analyze every requested TypeScript file with the configured project.",
        remediation:
          "Verify that the staged TypeScript configuration includes every staged TypeScript file, then retry. If it does, report a Zedbee typed-lint compatibility issue.",
      });
    }
    throw new Error(
      typescriptFiles.length > 0
        ? "Typed lint analysis failed."
        : "Managed lint analysis failed.",
    );
  }
}

export const lintAdapter: ObservationCheckAdapter = {
  id: "lint",
  output: "observations",

  async inspect(context) {
    const changedPaths = new Set(
      [...context.changeSet.files.values()]
        .filter((file) => file.status !== "deleted")
        .map((file) => file.path),
    );
    const workspaces = context.targetInspection.workspaces.filter(
      (workspace) =>
        workspace.sourceFiles.length > 0 &&
        (context.config.checks.lint.when === "always" ||
          sourceChanged(workspace, changedPaths)),
    );
    if (workspaces.length === 0) {
      return { applies: false, reason: "No supported staged source files" };
    }
    return {
      applies: true,
      executionClass: "project-analysis",
      requiresBaseline: true,
      targets: workspaces.map(targetFor),
    };
  },

  async collect(context): Promise<CheckObservationSet> {
    const [baselineObservations, targetObservations] = await Promise.all([
      collectSide(
        context.snapshots.baselineDir,
        context.repositoryRoot,
        context.baselineInspection,
        context.target,
      ),
      collectSide(
        context.snapshots.targetDir,
        context.repositoryRoot,
        context.targetInspection,
        context.target,
      ),
    ]);
    return {
      checkId: "lint",
      target: context.target,
      baselineObservations,
      targetObservations,
    };
  },
};
