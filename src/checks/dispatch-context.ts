import {
  CHECK_IDS,
  type CheckId,
  type ResolvedCheckPolicy,
  type ResolvedCheckPolicyPatch,
  type ResolvedPolicyOverride,
  type ResolvedConfig,
} from "../config/schema.js";
import type { FilePolicyResolver } from "../config/file-policy.js";
import {
  immutableConfigurationSnapshot,
  snapshotManagedPolicy,
} from "../config/settings-registry.js";
import { readonlyMap } from "../core/immutable-map.js";
import type { ChangeSet, ChangedFile } from "../git/change-set.js";
import type { RepositoryInspection } from "../inspection/types.js";
import type {
  InspectionContext,
  CheckRunContext,
  CheckTarget,
} from "./adapter.js";

export type DispatchContext = InspectionContext &
  Pick<CheckRunContext, "snapshots" | "signal"> & {
    readonly policyForFile: FilePolicyResolver;
  };

export function immutablePolicy<
  T extends ResolvedCheckPolicy | ResolvedCheckPolicyPatch,
>(checkId: string, policy: Readonly<T>): Readonly<T> {
  return CHECK_IDS.includes(checkId as CheckId)
    ? snapshotManagedPolicy(checkId as CheckId, policy)
    : immutableConfigurationSnapshot(policy);
}

function snapshotChangedFile(file: ChangedFile): Readonly<ChangedFile> {
  return Object.freeze({
    path: file.path,
    ...(file.previousPath === undefined
      ? {}
      : { previousPath: file.previousPath }),
    status: file.status,
    addedRanges: Object.freeze(
      file.addedRanges.map((range) =>
        Object.freeze({ start: range.start, end: range.end }),
      ),
    ),
  });
}

function snapshotChangeSet(changeSet: ChangeSet): ChangeSet {
  const files = readonlyMap(
    [...changeSet.files].map(
      ([path, file]) => [path, snapshotChangedFile(file)] as const,
    ),
  );
  return Object.freeze({
    files,
    isEmpty: changeSet.isEmpty,
    containsAddedLine(file: string, line: number) {
      return (
        files
          .get(file.replaceAll("\\", "/"))
          ?.addedRanges.some(
            (range) => line >= range.start && line <= range.end,
          ) ?? false
      );
    },
  });
}

function snapshotOverride(
  override: ResolvedPolicyOverride,
): ResolvedPolicyOverride {
  return Object.freeze({
    files: Object.freeze([...override.files]),
    ...(override.excludeFiles === undefined
      ? {}
      : { excludeFiles: Object.freeze([...override.excludeFiles]) }),
    checks: Object.freeze(
      Object.fromEntries(
        Object.entries(override.checks).map(([id, patch]) => [
          id,
          patch === undefined ? undefined : immutablePolicy(id, patch),
        ]),
      ),
    ),
    configurationOrigins: snapshotConfigurationOrigins(
      override.configurationOrigins,
    ),
    ...(override.generated === undefined
      ? {}
      : { generated: override.generated }),
  });
}

function snapshotConfigurationOrigins(
  origins: ResolvedConfig["configurationOrigins"] | undefined,
): ResolvedConfig["configurationOrigins"] {
  return immutableConfigurationSnapshot(
    Object.fromEntries(
      CHECK_IDS.map((checkId) => [checkId, origins?.[checkId] ?? {}]),
    ),
  ) as ResolvedConfig["configurationOrigins"];
}

function snapshotConfig(config: ResolvedConfig): ResolvedConfig {
  return Object.freeze({
    schemaVersion: config.schemaVersion,
    profile: config.profile,
    pathExclusions: immutableConfigurationSnapshot(
      config.pathExclusions,
    ) as ResolvedConfig["pathExclusions"],
    checks: Object.freeze(
      Object.fromEntries(
        Object.entries(config.checks).map(([id, policy]) => [
          id,
          immutablePolicy(id, policy),
        ]),
      ),
    ) as ResolvedConfig["checks"],
    overrides: Object.freeze(config.overrides.map(snapshotOverride)),
    reporting: immutableConfigurationSnapshot(config.reporting),
    resources: immutableConfigurationSnapshot(config.resources),
    configurationOrigins: snapshotConfigurationOrigins(
      config.configurationOrigins,
    ),
    failOnIncomplete: config.failOnIncomplete,
    ...(config.configPath === undefined
      ? {}
      : { configPath: config.configPath }),
  });
}

function snapshotInspection(
  inspection: RepositoryInspection,
): RepositoryInspection {
  return Object.freeze({
    snapshotRoot: inspection.snapshotRoot,
    packageManager: inspection.packageManager,
    lockfiles: Object.freeze([...inspection.lockfiles]),
    workspaces: Object.freeze(
      inspection.workspaces.map((workspace) =>
        Object.freeze({
          ...(workspace.name === undefined ? {} : { name: workspace.name }),
          relativeRoot: workspace.relativeRoot,
          manifestPath: workspace.manifestPath,
          sourceFiles: Object.freeze([...workspace.sourceFiles]),
          tsconfigPaths: Object.freeze([...workspace.tsconfigPaths]),
          environments: Object.freeze([...workspace.environments]),
          ...(workspace.productionDependencies === undefined
            ? {}
            : {
                productionDependencies: Object.freeze([
                  ...workspace.productionDependencies,
                ]),
              }),
          ...(workspace.developmentDependencies === undefined
            ? {}
            : {
                developmentDependencies: Object.freeze([
                  ...workspace.developmentDependencies,
                ]),
              }),
          dependencyDeclarations: Object.freeze(
            workspace.dependencyDeclarations.map((declaration) =>
              Object.freeze({
                name: declaration.name,
                specifier: declaration.specifier,
                section: declaration.section,
              }),
            ),
          ),
        }),
      ),
    ),
  });
}

export function adapterBaseContext(context: DispatchContext): DispatchContext {
  return Object.freeze({
    repositoryRoot: context.repositoryRoot,
    ...(context.mergeComparison === true ? { mergeComparison: true } : {}),
    changeSet: snapshotChangeSet(context.changeSet),
    config: snapshotConfig(context.config),
    snapshots: Object.freeze({
      baselineDir: context.snapshots.baselineDir,
      targetDir: context.snapshots.targetDir,
      baselineRef: context.snapshots.baselineRef,
      targetRef: context.snapshots.targetRef,
      baselineUnsupportedEntries: Object.freeze(
        (context.snapshots.baselineUnsupportedEntries ?? []).map((entry) =>
          Object.freeze({ ...entry }),
        ),
      ),
      unsupportedEntries: Object.freeze(
        context.snapshots.unsupportedEntries.map((entry) =>
          Object.freeze({ ...entry }),
        ),
      ),
    }),
    baselineInspection: snapshotInspection(context.baselineInspection),
    targetInspection: snapshotInspection(context.targetInspection),
    signal: context.signal,
    policyForFile: context.policyForFile,
    filePolicyConfig: snapshotConfig(context.config),
    ...(context.projectPrettierTrust === true
      ? { projectPrettierTrust: true }
      : {}),
  });
}

export function inspectionContext(
  context: DispatchContext,
  checkId: string,
  policy: ResolvedCheckPolicy,
): InspectionContext {
  return Object.freeze({
    repositoryRoot: context.repositoryRoot,
    changeSet: context.changeSet,
    config: snapshotConfig({
      ...context.config,
      checks: { ...context.config.checks, [checkId]: policy },
    }),
    filePolicyConfig: context.config,
    baselineInspection: context.baselineInspection,
    targetInspection: context.targetInspection,
    ...(context.mergeComparison === true ? { mergeComparison: true } : {}),
  });
}

export function scopedContext(
  context: DispatchContext,
  checkId: string,
  target: CheckTarget,
  policy: ResolvedCheckPolicy,
): CheckRunContext {
  const config = snapshotConfig({
    ...context.config,
    checks: { ...context.config.checks, [checkId]: policy },
  });
  return Object.freeze({
    ...context,
    config,
    target: Object.freeze({ ...target }),
    // Keep the adapter snapshot detached from the authoritative execution
    // envelope while preserving the same deeply immutable behavior.
    policy: Object.freeze({ ...policy }),
  });
}
