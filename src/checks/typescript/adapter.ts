import { inspectManagedCheck } from "../applicability.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { settleSnapshotSides } from "../settle-snapshot-sides.js";
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
import { CapturedDependencies } from "../../cache/captured-dependencies.js";

const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/iu;

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
  dependencies: CapturedDependencies,
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
  const { programs } = createSnapshotProgram({ ...input, dependencies });
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

  inspect: (context: import("../adapter.js").InspectionContext) =>
    inspectManagedCheck("types", context),

  async collect(context): Promise<CheckObservationSet> {
    try {
      const dependencies = new CapturedDependencies(context);
      const [baselineObservations, targetObservations] =
        await settleSnapshotSides(
          () =>
            collectSide(
              context.snapshots.baselineDir,
              context.repositoryRoot,
              context.baselineInspection,
              context.target,
              dependencies,
            ),
          () =>
            collectSide(
              context.snapshots.targetDir,
              context.repositoryRoot,
              context.targetInspection,
              context.target,
              dependencies,
            ),
          context.signal,
        );
      const dependencyInputs = dependencies.manifest();
      return {
        checkId: "types",
        target: context.target,
        baselineObservations,
        targetObservations,
        ...(dependencyInputs === undefined ? {} : { dependencyInputs }),
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
