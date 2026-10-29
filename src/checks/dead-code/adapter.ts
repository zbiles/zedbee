import {
  loadSnapshotAliases,
  sourceModuleSpecifiers,
} from "../typescript/aliases.js";
import { inspectManagedCheck } from "../applicability.js";
import { projectInputsMayHaveChanged } from "../project-inputs.js";
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
import {
  CapturedDependencies,
  type DependencyCaptureContext,
} from "../../cache/captured-dependencies.js";
import {
  sanitizeDependencyInputManifest,
  type DependencyInputManifest,
} from "../../cache/dependency-inputs.js";
import { exportCurrentAnalysisSourceCapture } from "../../inspection/source-capture.js";
import { runCapturedKnip } from "./executor.js";
import { createManagedKnipConfig } from "./managed-config.js";
import { parseKnipReport } from "./parse-report.js";
import { createKnipImportValidator } from "./import-boundary.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const INERT_TSCONFIG = ".zedbee-managed-no-tsconfig.json";

function workspaceFor(
  inspection: RepositoryInspection,
  target: CheckTarget,
): WorkspaceInspection | undefined {
  return inspection.workspaces.find(
    ({ relativeRoot }) => relativeRoot === target.relativeRoot,
  );
}

async function validateSnapshotInputs(
  snapshotRoot: string,
  workspace: WorkspaceInspection,
  capture?: CapturedDependencies,
): Promise<void> {
  const registry = await captureSnapshotRegistry(snapshotRoot);
  const aliases = await loadSnapshotAliases(snapshotRoot, workspace);
  const { validateImport, collectCommentImports } =
    await createKnipImportValidator(
      registry,
      capture === undefined
        ? undefined
        : async (path) => capture.assertMissing(path),
      (sourcePath, specifier) => aliases.resolve(sourcePath, specifier),
    );
  if (registry.resolve(INERT_TSCONFIG) !== undefined) {
    throw new TypeError("Reserved managed Knip path is present");
  }
  for (const sourcePath of workspace.sourceFiles) {
    const source = await readContainedFile(registry, sourcePath);
    for (const specifier of sourceModuleSpecifiers(
      sourcePath,
      source,
      collectCommentImports,
    )) {
      await validateImport(sourcePath, specifier);
    }
  }
}

async function collectSide(
  snapshotRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
  signal: AbortSignal,
  captureContext: DependencyCaptureContext,
  guards: CapturedDependencies,
): Promise<{
  observations: readonly Observation[];
  dependencyInputs?: DependencyInputManifest;
}> {
  signal.throwIfAborted();
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (canonicalRoot !== inspection.snapshotRoot) {
    throw new TypeError("Inspection does not match Knip snapshot");
  }
  const workspace = workspaceFor(inspection, target);
  if (workspace === undefined)
    return {
      observations: Object.freeze([]),
      dependencyInputs: guards.manifest()!,
    };
  await validateSnapshotInputs(canonicalRoot, workspace, guards);
  const sourceCapture = exportCurrentAnalysisSourceCapture();
  const result = await runCapturedKnip(
    {
      context: captureContext,
      snapshotRoot: canonicalRoot,
      workspace: workspace.relativeRoot,
      config: await createManagedKnipConfig(
        canonicalRoot,
        inspection,
        workspace,
        async (path) => guards.assertMissing(path),
      ),
      ...(sourceCapture === undefined ? {} : { sourceCapture }),
    },
    signal,
  );
  signal.throwIfAborted();
  await validateSnapshotInputs(canonicalRoot, workspace);
  return {
    observations: parseKnipReport(
      result.report,
      new Set([...workspace.sourceFiles, workspace.manifestPath]),
    ),
    ...(result.dependencyInputs === undefined
      ? {}
      : { dependencyInputs: result.dependencyInputs }),
  };
}

export const deadCodeAdapter: ObservationCheckAdapter = {
  id: "deadCode",
  output: "observations",
  inspect: (context: import("../adapter.js").InspectionContext) =>
    inspectManagedCheck("deadCode", context),
  async collect(context: CheckRunContext): Promise<CheckObservationSet> {
    try {
      const captureContext = {
        repositoryRoot: context.repositoryRoot,
        snapshots: {
          baselineDir: context.baselineInspection.snapshotRoot,
          targetDir: context.targetInspection.snapshotRoot,
        },
      };
      const guards = new CapturedDependencies(captureContext, "knip");
      const baseline = await collectSide(
        context.snapshots.baselineDir,
        context.baselineInspection,
        context.target,
        context.signal,
        captureContext,
        guards,
      );
      const target = await collectSide(
        context.snapshots.targetDir,
        context.targetInspection,
        context.target,
        context.signal,
        captureContext,
        guards,
      );
      const manifests = [
        guards.manifest(),
        baseline.dependencyInputs,
        target.dependencyInputs,
      ];
      let dependencyInputs: DependencyInputManifest | undefined;
      if (
        manifests.every(
          (item): item is DependencyInputManifest => item !== undefined,
        )
      ) {
        const probes = new Map<
          string,
          DependencyInputManifest["probes"][number]
        >();
        let consistent = true;
        for (const manifest of manifests) {
          if (manifest.roots !== manifests[0]!.roots) consistent = false;
          for (const probe of manifest.probes) {
            const key = `${probe.path}:${probe.kind === "directory" ? "listing" : "entry"}`;
            const previous = probes.get(key);
            if (
              previous !== undefined &&
              JSON.stringify(previous) !== JSON.stringify(probe)
            )
              consistent = false;
            probes.set(key, probe);
          }
        }
        if (consistent) {
          try {
            dependencyInputs = sanitizeDependencyInputManifest({
              version: 1,
              roots: manifests[0]!.roots,
              probes: [...probes.values()].sort((a, b) =>
                compareCodeUnits(`${a.path}:${a.kind}`, `${b.path}:${b.kind}`),
              ),
            });
          } catch {
            /* Bounded unsupported metadata remains uncached. */
          }
        }
      }
      return {
        checkId: "deadCode",
        target: context.target,
        baselineObservations: baseline.observations,
        targetObservations: target.observations,
        ...(dependencyInputs === undefined ? {} : { dependencyInputs }),
        projectDelta: await projectInputsMayHaveChanged(
          context,
          context.target,
        ),
      };
    } catch (error) {
      throw new Error("Dead-code analysis failed.", { cause: error });
    }
  },
};
