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
import { CheckIncompleteError } from "../incomplete-error.js";
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
  side: "baseline" | "staged",
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
    try {
      observations.push(...collectStructuralSecurityObservations(file, source));
    } catch {
      throw new CheckIncompleteError({
        code: "STRUCTURAL_SECURITY_PARSE_FAILED",
        message: `Structural security could not parse a ${side} source file.`,
        path: file,
        remediation:
          "Verify that this file uses valid JavaScript or TypeScript syntax, then retry. If the project accepts this syntax, report a Zedbee parser compatibility issue.",
      });
    }
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
          "baseline",
        ),
        collectSide(
          context.snapshots.targetDir,
          context.targetInspection,
          context.target,
          context.signal,
          "staged",
        ),
      ]);
      return {
        checkId: "structuralSecurity",
        target: context.target,
        baselineObservations,
        targetObservations,
      };
    } catch (error) {
      if (error instanceof CheckIncompleteError) throw error;
      throw new Error("Structural security analysis failed.");
    }
  },
};
