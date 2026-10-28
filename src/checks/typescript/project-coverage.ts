import type { CapturedDependencies } from "../../cache/captured-dependencies.js";
import type { SnapshotSide } from "../../config/file-policy.js";
import type { WorkspaceInspection } from "../../inspection/types.js";
import type { CheckRunContext } from "../adapter.js";
import type { AnalyzerOperation } from "../diagnostics.js";
import {
  configurationIncompleteError,
  loadSnapshotProjectSet,
  type SnapshotProjectSet,
} from "./projects.js";

export interface SnapshotProjectCoverage {
  load(
    workspace: WorkspaceInspection,
    side: SnapshotSide,
  ): Promise<SnapshotProjectSet>;
  required(
    uncovered: readonly string[],
    workspace: WorkspaceInspection,
    side: SnapshotSide,
  ): Promise<readonly string[]>;
}

/** Keep project-wide diagnostics without making existing coverage debt mandatory.
 * Both sides share their loaded projects so detecting a lost include does not
 * build the baseline twice.
 */
export function createSnapshotProjectCoverage(
  context: CheckRunContext,
  checkId: "lint" | "types",
  dependencies?: CapturedDependencies,
  operation: AnalyzerOperation = "collect",
): SnapshotProjectCoverage {
  const projects = new Map<string, Promise<SnapshotProjectSet>>();
  const changed = {
    baseline: new Set<string>(),
    target: new Set<string>(),
  };
  for (const file of context.changeSet.files.values()) {
    if (file.status !== "added")
      changed.baseline.add(file.previousPath ?? file.path);
    if (file.status !== "deleted") changed.target.add(file.path);
  }
  const load: SnapshotProjectCoverage["load"] = (workspace, side) => {
    const key = `${side}:${workspace.relativeRoot}`;
    let pending = projects.get(key);
    if (pending === undefined) {
      pending = loadSnapshotProjectSet(
        side === "baseline"
          ? context.snapshots.baselineDir
          : context.snapshots.targetDir,
        context.repositoryRoot,
        workspace,
        dependencies,
      ).catch((error: unknown) => {
        throw (
          configurationIncompleteError(error, checkId, side, operation) ?? error
        );
      });
      projects.set(key, pending);
    }
    return pending;
  };
  return {
    load,
    async required(uncovered, workspace, side) {
      context.signal.throwIfAborted();
      const directlyRequired = (path: string) =>
        changed[side].has(path) ||
        context.policyForFile(checkId, path, side).when === "always";
      if (side === "baseline" || uncovered.every(directlyRequired))
        return uncovered.filter(directlyRequired);
      const baselineWorkspace = context.baselineInspection.workspaces.find(
        ({ relativeRoot }) => relativeRoot === workspace.relativeRoot,
      );
      // A newly discovered project has no existing coverage debt to inherit.
      if (baselineWorkspace === undefined) return uncovered;
      const baseline = await load(baselineWorkspace, "baseline");
      context.signal.throwIfAborted();
      return uncovered.filter(
        (path) => directlyRequired(path) || baseline.covered.has(path),
      );
    },
  };
}
