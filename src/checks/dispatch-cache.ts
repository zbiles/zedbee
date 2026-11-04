import {
  CHECK_IDS,
  type CheckId,
  type ResolvedCheckPolicy,
} from "../config/schema.js";
import type { RepositoryInspection } from "../inspection/types.js";
import { compareCodeUnits } from "../core/compare.js";
import {
  changeSetCacheDigest,
  createEffectiveBehaviorFingerprint,
  createObservationCacheKeyBuilder,
} from "../cache/key.js";
import { sanitizeCacheableObservationSet } from "../cache/store.js";
import { validateDependencyInputs } from "../cache/captured-dependencies.js";
import { observationCacheEngineIdentity } from "./engine-identity.js";
import {
  isCacheableObservationCheck,
  requiresDependencyInputs,
} from "./metadata.js";
import { createDiagnosticMessageSanitizer } from "./diagnostic-messages.js";
import type {
  CheckObservationSet,
  CheckRunContext,
  CheckTarget,
} from "./adapter.js";
import type { AdapterSnapshot } from "./dispatch-adapter.js";
import type { DispatchContext } from "./dispatch-context.js";
import type { DispatchOptions } from "./dispatcher.js";

function cacheInspection(
  inspection: RepositoryInspection,
  target: CheckTarget,
): unknown {
  const workspaces = inspection.workspaces
    .filter(
      (workspace) =>
        target.kind === "repository" ||
        workspace.relativeRoot === target.relativeRoot,
    )
    .map((workspace) => ({
      name: workspace.name,
      relativeRoot: workspace.relativeRoot,
      manifestPath: workspace.manifestPath,
      sourceFiles: workspace.sourceFiles,
      tsconfigPaths: workspace.tsconfigPaths,
      environments: workspace.environments,
      dependencyDeclarations: workspace.dependencyDeclarations,
      productionDependencies: workspace.productionDependencies,
      developmentDependencies: workspace.developmentDependencies,
    }));
  return {
    packageManager: inspection.packageManager,
    lockfiles: inspection.lockfiles,
    workspaces,
  };
}

const LINT_SOURCE_PATH = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/u;
const REACT_COMPLEXITY_SOURCE_PATH = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const FILE_BEHAVIOR_CHECKS = new Set<CheckId>([
  "lint",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "reactCorrectness",
  "reactAccessibility",
]);

function isFileBehaviorPath(checkId: CheckId, path: string): boolean {
  return checkId === "lint"
    ? LINT_SOURCE_PATH.test(path)
    : REACT_COMPLEXITY_SOURCE_PATH.test(path);
}

function cacheBehaviorPaths(
  checkId: CheckId,
  target: CheckTarget,
  baseline: RepositoryInspection,
  staged: RepositoryInspection,
): readonly string[] {
  if (!FILE_BEHAVIOR_CHECKS.has(checkId)) return Object.freeze([]);
  const paths = [baseline, staged].flatMap((inspection) =>
    inspection.workspaces
      .filter(
        ({ relativeRoot }) =>
          target.kind === "repository" || relativeRoot === target.relativeRoot,
      )
      .flatMap(({ sourceFiles }) =>
        sourceFiles.filter((path) => isFileBehaviorPath(checkId, path)),
      ),
  );
  return Object.freeze([...new Set(paths)].sort(compareCodeUnits));
}

function sameTarget(left: CheckTarget, right: CheckTarget): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.relativeRoot === right.relativeRoot
  );
}

/** Trusted dispatch-local cache state is never included in adapter contexts. */
export function createDispatchObservationCollector(
  context: DispatchContext,
  options: DispatchOptions,
): (
  adapter: Extract<AdapterSnapshot, { output: "observations" }>,
  runContext: CheckRunContext,
) => Promise<CheckObservationSet> {
  const sanitizeMessages = createDiagnosticMessageSanitizer();
  const identities = new Map<string, string | undefined>();
  const engineIdentityFor =
    options.cacheEngineIdentity ??
    ((checkId: string) => {
      if (!identities.has(checkId))
        identities.set(checkId, observationCacheEngineIdentity(checkId));
      return identities.get(checkId);
    });
  let cacheKeyFor:
    ReturnType<typeof createObservationCacheKeyBuilder> | undefined;
  let behaviorFor:
    ReturnType<typeof createEffectiveBehaviorFingerprint> | undefined;
  let changeSetDigest: string | undefined;
  let preparationFailed = false;
  function prepareCache() {
    if (preparationFailed) throw new Error("Cache preparation unavailable");
    try {
      // These inputs are immutable for this dispatch. Reuse canonical metadata,
      // matchers and rename indexes across every eligible target and cache hit.
      behaviorFor ??= createEffectiveBehaviorFingerprint(
        context.config,
        context.changeSet,
      );
      changeSetDigest ??= changeSetCacheDigest(context.changeSet);
      cacheKeyFor ??= createObservationCacheKeyBuilder(
        context.snapshots.baselineDir,
        context.snapshots.targetDir,
        context.snapshots.targetRef === "index"
          ? {
              mode: "index",
              baseline: context.snapshots.baselineRef,
              target: "index",
            }
          : {
              mode: "base",
              baseline: context.snapshots.baselineRef,
              target: context.snapshots.targetRef,
            },
      );
      return { cacheKeyFor, behaviorFor, changeSetDigest };
    } catch (error) {
      preparationFailed = true;
      throw error;
    }
  }
  return async (adapter, runContext) => {
    if (
      !isCacheableObservationCheck(adapter.id) ||
      (options.cache === undefined && options.cacheEngineIdentity === undefined)
    ) {
      return sanitizeMessages(
        await Reflect.apply(adapter.collect, undefined, [runContext]),
      );
    }
    const engineIdentity = engineIdentityFor(adapter.id);
    if (engineIdentity === undefined) {
      return sanitizeMessages(
        await Reflect.apply(adapter.collect, undefined, [runContext]),
      );
    }
    let cacheKey: string | undefined;
    if (options.cache !== undefined) {
      try {
        const prepared = prepareCache();
        const checkId = adapter.id as CheckId;
        cacheKey = await prepared.cacheKeyFor({
          checkId: adapter.id,
          engineIdentity,
          policy: FILE_BEHAVIOR_CHECKS.has(checkId)
            ? context.config.checks[checkId]
            : runContext.policy,
          checkTarget: runContext.target,
          relevantConfig: {
            schemaVersion: runContext.config.schemaVersion,
            behavior: CHECK_IDS.includes(checkId)
              ? prepared.behaviorFor(
                  checkId,
                  cacheBehaviorPaths(
                    checkId,
                    runContext.target,
                    context.baselineInspection,
                    context.targetInspection,
                  ),
                )
              : undefined,
            changeSetDigest: prepared.changeSetDigest,
            baseline: cacheInspection(
              runContext.baselineInspection,
              runContext.target,
            ),
            target: cacheInspection(
              runContext.targetInspection,
              runContext.target,
            ),
          },
        });
        const cached = await options.cache.get(cacheKey).catch(() => undefined);
        if (
          cached !== undefined &&
          cached.checkId === adapter.id &&
          sameTarget(cached.target, runContext.target) &&
          (!requiresDependencyInputs(adapter.id) ||
            validateDependencyInputs(
              cached.dependencyInputs,
              runContext,
              adapter.id === "deadCode" ? "knip" : false,
            ))
        ) {
          return sanitizeMessages(sanitizeCacheableObservationSet(cached));
        }
      } catch {
        cacheKey = undefined;
      }
    }

    const collected = await sanitizeMessages(
      await Reflect.apply(adapter.collect, undefined, [runContext]),
    );
    if (
      cacheKey !== undefined &&
      options.cache !== undefined &&
      !runContext.signal.aborted &&
      (adapter.id !== "deadCode" ||
        (await cacheKeyFor?.matchesSnapshotFiles(
          collected.dependencyInputs,
        ))) &&
      (!requiresDependencyInputs(adapter.id) ||
        validateDependencyInputs(
          collected.dependencyInputs,
          runContext,
          adapter.id === "deadCode" ? "knip" : false,
        ))
    ) {
      await options.cache.set(cacheKey, collected).catch(() => undefined);
    }
    return collected;
  };
}
