import { isAbsolute, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import type {
  CheckObservationSet,
  CheckRunContext,
  CheckTarget,
  ObservationCheckAdapter,
} from "../adapter.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import { createSnapshotProgram } from "./compiler-host.js";
import { loadSnapshotProgramInput } from "./config.js";
import { convertTypescriptDiagnostic } from "./convert-diagnostic.js";

const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/iu;

function ownsChangedSource(
  workspace: WorkspaceInspection,
  changedPaths: ReadonlySet<string>,
): boolean {
  return workspace.sourceFiles.some(
    (path) => TYPESCRIPT_SOURCE.test(path) && changedPaths.has(path),
  );
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
  const workspace = workspaceFor(inspection, target);
  if (
    workspace === undefined ||
    !workspace.sourceFiles.some((path) => TYPESCRIPT_SOURCE.test(path))
  ) {
    return Object.freeze([]);
  }
  const input = await loadSnapshotProgramInput(
    snapshotRoot,
    repositoryRoot,
    workspace,
  );
  const { programs } = createSnapshotProgram(input);
  const observations = programs
    .flatMap((program) => ts.getPreEmitDiagnostics(program))
    .map((diagnostic) =>
      convertTypescriptDiagnostic(
        diagnostic,
        resolve(input.snapshotRoot ?? snapshotRoot),
        resolve(repositoryRoot),
      ),
    )
    .filter(
      (observation): observation is Observation => observation !== undefined,
    )
    .sort(
      (left, right) =>
        compareCodeUnits(left.identity, right.identity) ||
        compareCodeUnits(left.message, right.message),
    );
  return Object.freeze(observations);
}

export const typescriptAdapter: ObservationCheckAdapter = {
  id: "types",
  output: "observations",

  async inspect(context) {
    const changedPaths = new Set(
      [...context.changeSet.files.values()]
        .filter((file) => file.status !== "deleted")
        .map((file) => file.path),
    );
    const workspaces = context.targetInspection.workspaces.filter(
      (workspace) =>
        workspace.sourceFiles.some((path) => TYPESCRIPT_SOURCE.test(path)) &&
        (context.config.checks.types.when === "always" ||
          ownsChangedSource(workspace, changedPaths)),
    );
    if (workspaces.length === 0) {
      return {
        applies: false,
        reason: "No supported staged TypeScript source files",
      };
    }
    return {
      applies: true,
      executionClass: "project-analysis",
      requiresBaseline: true,
      targets: workspaces.map(targetFor),
    };
  },

  async collect(context): Promise<CheckObservationSet> {
    try {
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
        checkId: "types",
        target: context.target,
        baselineObservations,
        targetObservations,
      };
    } catch {
      throw new Error("TypeScript analysis failed.");
    }
  },
};

export interface InMemoryTypescriptSnapshots {
  readonly baseline: Readonly<Record<string, string>>;
  readonly target: Readonly<Record<string, string>>;
  readonly live?: Readonly<Record<string, string>>;
}

/** Focused pure harness used to verify baseline comparison without filesystem fixtures. */
export async function analyzeTypescriptSnapshots(
  snapshots: InMemoryTypescriptSnapshots,
): Promise<readonly Observation[]> {
  const analyze = (
    files: Readonly<Record<string, string>>,
  ): readonly Observation[] => {
    const rootNames = Object.keys(files).filter((path) =>
      TYPESCRIPT_SOURCE.test(path),
    );
    const { programs } = createSnapshotProgram({
      repositoryRoot: process.cwd(),
      files,
      rootNames,
      options: { strict: true },
    });
    return programs
      .flatMap((program) => ts.getPreEmitDiagnostics(program))
      .map((diagnostic) =>
        convertTypescriptDiagnostic(diagnostic, process.cwd(), process.cwd()),
      )
      .filter(
        (observation): observation is Observation => observation !== undefined,
      );
  };
  const baseline = new Map(
    analyze(snapshots.baseline).map((item) => [item.identity, item]),
  );
  return Object.freeze(
    analyze(snapshots.target).filter((item) => !baseline.has(item.identity)),
  );
}
