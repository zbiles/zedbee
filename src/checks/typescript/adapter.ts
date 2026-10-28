import { inspectManagedCheck } from "../applicability.js";
import { collectRenamedBaselines } from "../renamed-baselines.js";
import { hasTypeScriptInputs } from "../compiler-inputs.js";
import { resolve } from "node:path";
import * as ts from "typescript";
import { settleSnapshotSides } from "../settle-snapshot-sides.js";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import type {
  CheckObservationSet,
  CheckTarget,
  ObservationCheckAdapter,
} from "../adapter.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import { createSnapshotProgram } from "./compiler-host.js";
import {
  createSnapshotProjectCoverage,
  type SnapshotProjectCoverage,
} from "./project-coverage.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import type {
  FilePolicyResolver,
  SnapshotSide,
} from "../../config/file-policy.js";
import { convertTypescriptDiagnostic } from "./convert-diagnostic.js";
import { captureAnalysisDependencies } from "./reuse-inputs.js";
import {
  pairTypescriptObservations,
  type TypescriptSnapshotObservations,
} from "./compare-diagnostics.js";

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
  repositoryRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
  coverage: SnapshotProjectCoverage,
  side: SnapshotSide,
  policyForFile: FilePolicyResolver,
  signal: AbortSignal,
  requestedPaths?: ReadonlySet<string>,
): Promise<TypescriptSnapshotObservations> {
  const workspace = workspaceFor(inspection, target);
  if (workspace === undefined || !hasTypeScriptInputs(workspace)) {
    return { observations: Object.freeze([]), files: {} };
  }
  signal.throwIfAborted();
  const requested = workspace.sourceFiles.filter(
    (path) =>
      (requestedPaths === undefined || requestedPaths.has(path)) &&
      TYPESCRIPT_SOURCE.test(path) &&
      policyForFile("types", path, side).severity !== "off",
  );
  if (requested.length === 0)
    return { observations: Object.freeze([]), files: {} };
  const projectSet = await coverage.load(workspace, side);
  signal.throwIfAborted();
  const { programs, covered, projectPaths, files, canonicalRoot } = projectSet;
  const uncovered = await coverage.required(
    requested.filter((path) => !covered.has(path)).sort(compareCodeUnits),
    workspace,
    side,
  );
  if (uncovered.length > 0)
    throw new CheckIncompleteError({
      code: "TYPESCRIPT_PROJECT_MISMATCH",
      message:
        "TypeScript analysis could not cover requested files with the loaded TypeScript projects.",
      remediation:
        'Add the requested files to "files" or "include" in the appropriate contained TypeScript configuration, or disable the types check for files intentionally outside a project.',
      path: uncovered[0]!,
      paths: uncovered,
      projectPaths,
      snapshot: side === "baseline" ? "last-commit" : "staged",
    });
  const observations = programs
    .flatMap((program) => ts.getPreEmitDiagnostics(program))
    .map((diagnostic) =>
      convertTypescriptDiagnostic(
        diagnostic,
        resolve(canonicalRoot),
        resolve(repositoryRoot),
      ),
    )
    .filter(
      (observation): observation is Observation => observation !== undefined,
    )
    .filter(
      (observation) =>
        requestedPaths === undefined ||
        (observation.location !== undefined &&
          requestedPaths.has(observation.location.file)),
    )
    .sort(
      (left, right) =>
        compareCodeUnits(left.identity, right.identity) ||
        compareCodeUnits(left.message, right.message),
    );
  return { observations: Object.freeze(observations), files };
}

export const typescriptAdapter: ObservationCheckAdapter = {
  id: "types",
  output: "observations",

  inspect: (context: import("../adapter.js").InspectionContext) =>
    inspectManagedCheck("types", context),

  async collect(context): Promise<CheckObservationSet> {
    try {
      const dependencies = captureAnalysisDependencies(context);
      const coverage = createSnapshotProjectCoverage(
        context,
        "types",
        dependencies,
      );
      const [baseline, target] = await settleSnapshotSides(
        () =>
          collectRenamedBaselines(context, (baselineTarget, paths) =>
            collectSide(
              context.repositoryRoot,
              context.baselineInspection,
              baselineTarget,
              coverage,
              "baseline",
              context.policyForFile,
              context.signal,
              paths,
            ),
          ),
        () =>
          collectSide(
            context.repositoryRoot,
            context.targetInspection,
            context.target,
            coverage,
            "target",
            context.policyForFile,
            context.signal,
          ),
        context.signal,
      );
      const dependencyInputs = dependencies.manifest();
      return {
        checkId: "types",
        target: context.target,
        ...pairTypescriptObservations(baseline, target, context.changeSet),
        // A declaration edit can break references on otherwise unchanged lines.
        projectDelta: !context.changeSet.isEmpty,
        ...(dependencyInputs === undefined ? {} : { dependencyInputs }),
      };
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof CheckIncompleteError) throw error;
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
