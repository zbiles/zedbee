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
import { collectStructuralSecurityObservations } from "./rules.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;

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
    ({ relativeRoot }) => relativeRoot === target.relativeRoot,
  );
}

async function collectSide(
  snapshotRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
  signal: AbortSignal,
): Promise<readonly Observation[]> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (canonicalRoot !== inspection.snapshotRoot)
    throw new Error("Structural security analysis failed.");
  const registry = await captureSnapshotRegistry(canonicalRoot);
  const workspace = workspaceFor(inspection, target);
  if (workspace === undefined) return Object.freeze([]);
  const files = workspace.sourceFiles
    .filter((file) => SOURCE.test(file))
    .sort(compareCodeUnits);
  const observations: Observation[] = [];
  for (const file of files) {
    if (signal.aborted) throw new Error("Structural security analysis failed.");
    const source = await readContainedFile(registry, file);
    observations.push(...collectStructuralSecurityObservations(file, source));
  }
  return Object.freeze(
    observations.sort((left, right) =>
      compareCodeUnits(left.identity, right.identity),
    ),
  );
}

export const structuralSecurityAdapter: ObservationCheckAdapter = {
  id: "structuralSecurity",
  output: "observations",
  async inspect(context) {
    const changed = new Set(
      [...context.changeSet.files.values()]
        .filter(({ status }) => status !== "deleted")
        .map(({ path }) => path),
    );
    const workspaces = context.targetInspection.workspaces.filter((workspace) =>
      workspace.sourceFiles.some(
        (file) =>
          SOURCE.test(file) &&
          (context.config.checks.structuralSecurity.when === "always" ||
            changed.has(file)),
      ),
    );
    return workspaces.length === 0
      ? { applies: false, reason: "No supported staged source files" }
      : {
          applies: true,
          executionClass: "lightweight",
          requiresBaseline: true,
          targets: workspaces.map(targetFor),
        };
  },
  async collect(context: CheckRunContext): Promise<CheckObservationSet> {
    try {
      const [baselineObservations, targetObservations] = await Promise.all([
        collectSide(
          context.snapshots.baselineDir,
          context.baselineInspection,
          context.target,
          context.signal,
        ),
        collectSide(
          context.snapshots.targetDir,
          context.targetInspection,
          context.target,
          context.signal,
        ),
      ]);
      return {
        checkId: "structuralSecurity",
        target: context.target,
        baselineObservations,
        targetObservations,
      };
    } catch {
      throw new Error("Structural security analysis failed.");
    }
  },
};
