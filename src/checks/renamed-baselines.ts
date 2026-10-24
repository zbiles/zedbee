import type { CheckRunContext, CheckTarget } from "./adapter.js";
import type { SnapshotLocationObservations } from "../attribution/pair-locations.js";

/** A renamed file keeps its baseline even when its owning workspace changes. */
export async function collectRenamedBaselines(
  context: CheckRunContext,
  collect: (
    target: CheckTarget,
    paths?: ReadonlySet<string>,
  ) => Promise<SnapshotLocationObservations>,
): Promise<SnapshotLocationObservations> {
  const baseline = await collect(context.target);
  const targetFiles = new Set(
    context.targetInspection.workspaces.find(
      (workspace) => workspace.relativeRoot === context.target.relativeRoot,
    )?.sourceFiles,
  );
  const previousPaths = new Set(
    [...context.changeSet.files.values()]
      .filter((file) => file.status === "renamed" && targetFiles.has(file.path))
      .flatMap((file) =>
        file.previousPath === undefined ? [] : [file.previousPath],
      ),
  );
  const observations = [...baseline.observations];
  const files = { ...baseline.files };
  for (const workspace of context.baselineInspection.workspaces) {
    if (workspace.relativeRoot === context.target.relativeRoot) continue;
    const paths = new Set(
      workspace.sourceFiles.filter((path) => previousPaths.has(path)),
    );
    if (paths.size === 0) continue;
    context.signal.throwIfAborted();
    const previous = await collect(
      {
        id: workspace.relativeRoot,
        kind: "workspace",
        relativeRoot: workspace.relativeRoot,
      },
      paths,
    );
    observations.push(...previous.observations);
    Object.assign(files, previous.files);
  }
  return { observations, files };
}
