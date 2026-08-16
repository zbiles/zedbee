import pLimit from "p-limit";
import {
  CHECK_IDS,
  type CheckId,
  type ResolvedCheckPolicy,
} from "../config/schema.js";
import { resolveTargetPolicy } from "../config/target-policy.js";
import type { CheckResult } from "../core/types.js";
import type {
  CheckAdapter,
  CheckExecutionResult,
  CheckObservationSet,
  CheckRunContext,
  CheckTarget,
  CheckApplicability,
  ExecutionClass,
  InspectionContext,
  ObservationCheckAdapter,
  LegacyCheckResultAdapter,
} from "./adapter.js";
import type { ScanEvent } from "./events.js";
import { observationCheckResult } from "./observation-result.js";
import { sanitizeCheckResult } from "./sanitize-result.js";
import { sanitizeCheckTarget } from "./sanitize-target.js";
import type { ChangeSet, ChangedFile } from "../git/change-set.js";
import type { RepositoryInspection } from "../inspection/types.js";
import type {
  ResolvedConfig,
  ResolvedPolicyOverride,
} from "../config/schema.js";
import { displayResultForPolicy } from "../policy/evaluate.js";
import { compareCodeUnits } from "../core/compare.js";
import { displayLabel, displayProse } from "../core/display-text.js";
import {
  createObservationCacheKey,
  observationCacheEngineIdentity,
} from "../cache/key.js";
import {
  sanitizeCacheableObservationSet,
  type ObservationCache,
} from "../cache/store.js";

export interface DispatchOptions {
  clock?: () => number;
  onEvent?: (event: ScanEvent) => void;
  cache?: ObservationCache;
  cacheEngineIdentity?: (checkId: string) => string | undefined;
}

function checkPolicy(
  context: InspectionContext,
  checkId: string,
): ResolvedCheckPolicy | undefined {
  const checks = context.config.checks as unknown as Readonly<
    Record<string, ResolvedCheckPolicy | undefined>
  >;
  return checks[checkId];
}

type DispatchContext = Omit<CheckRunContext, "target" | "policy">;

function incomplete(
  checkId: string,
  durationMs: number,
  target?: string,
): CheckResult {
  return {
    checkId,
    ...(target === undefined ? {} : { target }),
    status: "incomplete",
    durationMs,
    findings: [],
    error: {
      code: "ADAPTER_FAILED",
      message: `Check ${checkId} failed`,
    },
  };
}

function immutablePolicy(
  policy: ResolvedCheckPolicy,
): Readonly<ResolvedCheckPolicy> {
  return Object.freeze({ ...policy });
}

function executionResult(
  result: CheckResult,
  policy: Readonly<ResolvedCheckPolicy> | null,
  target?: CheckTarget,
): CheckExecutionResult {
  return {
    result: sanitizeCheckResult(result),
    ...(target === undefined ? {} : { target }),
    policy,
  };
}

function mayBeEnabled(context: InspectionContext, checkId: string): boolean {
  const policy = checkPolicy(context, checkId);
  if (policy === undefined) return false;
  if (policy.severity !== "off") return true;
  if (!CHECK_IDS.includes(checkId as CheckId)) return false;
  return context.config.overrides.some(
    (override) =>
      override.checks[checkId as CheckId]?.severity !== undefined &&
      override.checks[checkId as CheckId]?.severity !== "off",
  );
}

function inspectionPolicy(
  context: InspectionContext,
  checkId: string,
): ResolvedCheckPolicy | undefined {
  const root = checkPolicy(context, checkId);
  if (root === undefined || !CHECK_IDS.includes(checkId as CheckId))
    return root;
  const patches = context.config.overrides
    .map((override) => override.checks[checkId as CheckId])
    .filter((patch) => patch !== undefined);
  if (patches.some((patch) => patch.network !== undefined)) {
    throw new TypeError("Network policy cannot be overridden by file scope");
  }
  const severities = [
    root.severity,
    ...patches.map((patch) => patch.severity),
  ].filter((severity) => severity !== undefined && severity !== "off");
  const severity = severities.includes("error")
    ? "error"
    : severities.includes("warn")
      ? "warn"
      : root.severity;
  const when =
    root.when === "always" || patches.some((patch) => patch.when === "always")
      ? "always"
      : "relevant";
  return { ...root, severity, when };
}

function readonlyMap<K, V>(
  entries: readonly (readonly [K, V])[],
): ReadonlyMap<K, V> {
  const internal = new Map(entries);
  let facade: ReadonlyMap<K, V>;
  facade = Object.freeze({
    get size() {
      return internal.size;
    },
    get(key: K) {
      return internal.get(key);
    },
    has(key: K) {
      return internal.has(key);
    },
    entries() {
      return internal.entries();
    },
    keys() {
      return internal.keys();
    },
    values() {
      return internal.values();
    },
    forEach(
      callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
      thisArg?: unknown,
    ) {
      internal.forEach((value, key) =>
        callback.call(thisArg, value, key, facade),
      );
    },
    [Symbol.iterator]() {
      return internal[Symbol.iterator]();
    },
  });
  return facade;
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
    checks: Object.freeze(
      Object.fromEntries(
        Object.entries(override.checks).map(([id, patch]) => [
          id,
          patch === undefined ? undefined : Object.freeze({ ...patch }),
        ]),
      ),
    ),
  });
}

function snapshotConfig(config: ResolvedConfig): ResolvedConfig {
  return Object.freeze({
    schemaVersion: config.schemaVersion,
    profile: config.profile,
    checks: Object.freeze(
      Object.fromEntries(
        Object.entries(config.checks).map(([id, policy]) => [
          id,
          Object.freeze({ ...policy }),
        ]),
      ),
    ) as ResolvedConfig["checks"],
    overrides: Object.freeze(config.overrides.map(snapshotOverride)),
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
        }),
      ),
    ),
  });
}

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
      productionDependencies: workspace.productionDependencies,
      developmentDependencies: workspace.developmentDependencies,
    }));
  return {
    packageManager: inspection.packageManager,
    lockfiles: inspection.lockfiles,
    workspaces,
  };
}

function sameTarget(left: CheckTarget, right: CheckTarget): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.relativeRoot === right.relativeRoot
  );
}

async function collectObservations(
  adapter: Extract<AdapterSnapshot, { output: "observations" }>,
  runContext: CheckRunContext,
  options: DispatchOptions,
): Promise<CheckObservationSet> {
  const engineIdentity = (
    options.cacheEngineIdentity ?? observationCacheEngineIdentity
  )(adapter.id);
  if (engineIdentity === undefined) {
    return Reflect.apply(adapter.collect, undefined, [runContext]);
  }
  let cacheKey: string | undefined;
  if (options.cache !== undefined && engineIdentity !== undefined) {
    try {
      cacheKey = await createObservationCacheKey({
        checkId: adapter.id,
        engineIdentity,
        policy: runContext.policy,
        target: runContext.target,
        baselineRoot: runContext.snapshots.baselineDir,
        targetRoot: runContext.snapshots.targetDir,
        relevantConfig: {
          schemaVersion: runContext.config.schemaVersion,
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
        sameTarget(cached.target, runContext.target)
      ) {
        return sanitizeCacheableObservationSet(cached);
      }
    } catch {
      cacheKey = undefined;
    }
  }

  const collected = sanitizeCacheableObservationSet(
    await Reflect.apply(adapter.collect, undefined, [runContext]),
  );
  if (
    cacheKey !== undefined &&
    options.cache !== undefined &&
    !runContext.signal.aborted
  ) {
    await options.cache.set(cacheKey, collected).catch(() => undefined);
  }
  return collected;
}

function adapterBaseContext(context: DispatchContext): DispatchContext {
  return Object.freeze({
    repositoryRoot: context.repositoryRoot,
    changeSet: snapshotChangeSet(context.changeSet),
    config: snapshotConfig(context.config),
    snapshots: Object.freeze({
      baselineDir: context.snapshots.baselineDir,
      targetDir: context.snapshots.targetDir,
      baselineRef: context.snapshots.baselineRef,
      unsupportedEntries: Object.freeze(
        context.snapshots.unsupportedEntries.map((entry) =>
          Object.freeze({ ...entry }),
        ),
      ),
    }),
    baselineInspection: snapshotInspection(context.baselineInspection),
    targetInspection: snapshotInspection(context.targetInspection),
    signal: context.signal,
  });
}

function inspectionContext(
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
    baselineInspection: context.baselineInspection,
    targetInspection: context.targetInspection,
  });
}

function scopedContext(
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
    // Adapter policy is a detached working copy. The authoritative immutable
    // execution policy is retained privately for attribution and enforcement.
    policy: { ...policy },
  });
}

function compareResults(
  left: CheckExecutionResult,
  right: CheckExecutionResult,
): number {
  return (
    compareCodeUnits(left.result.checkId, right.result.checkId) ||
    compareCodeUnits(left.result.target ?? "", right.result.target ?? "")
  );
}

function limiterFor(
  executionClass: ExecutionClass,
  limits: Readonly<Record<ExecutionClass, ReturnType<typeof pLimit>>>,
): ReturnType<typeof pLimit> {
  return limits[executionClass];
}

type AdapterSnapshot =
  | Readonly<{
      id: string;
      output: "observations";
      inspect: ObservationCheckAdapter["inspect"];
      collect: ObservationCheckAdapter["collect"];
    }>
  | Readonly<{
      id: "formatting";
      output: "legacy-check-result";
      inspect: LegacyCheckResultAdapter["inspect"];
      runLegacy: LegacyCheckResultAdapter["runLegacy"];
    }>;

type AdapterSnapshotResult =
  | Readonly<{ valid: true; adapter: AdapterSnapshot }>
  | Readonly<{ valid: false; id: string }>;

function adapterId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Adapter returned an invalid check id");
  }
  return displayLabel(value, "adapter check id");
}

function snapshotAdapter(raw: CheckAdapter): AdapterSnapshotResult {
  const candidate = raw as unknown as Record<string, unknown>;
  let id = "unknown";
  try {
    id = adapterId(candidate.id);
    const output = candidate.output;
    const inspect = candidate.inspect;
    if (typeof inspect !== "function") {
      throw new TypeError("Adapter returned an invalid inspect function");
    }
    const inspectFunction = inspect as ObservationCheckAdapter["inspect"];
    if (output === "observations") {
      const collect = candidate.collect;
      if (typeof collect !== "function") {
        throw new TypeError("Adapter returned an invalid collect function");
      }
      return Object.freeze({
        valid: true,
        adapter: Object.freeze({
          id,
          output,
          inspect: inspectFunction,
          collect: collect as ObservationCheckAdapter["collect"],
        }),
      });
    }
    if (output === "legacy-check-result" && id === "formatting") {
      const runLegacy = candidate.runLegacy;
      if (typeof runLegacy !== "function") {
        throw new TypeError("Adapter returned an invalid legacy function");
      }
      return Object.freeze({
        valid: true,
        adapter: Object.freeze({
          id,
          output,
          inspect: inspectFunction,
          runLegacy: runLegacy as LegacyCheckResultAdapter["runLegacy"],
        }),
      });
    }
    throw new TypeError("Adapter returned an invalid output contract");
  } catch {
    return Object.freeze({ valid: false, id });
  }
}

function snapshotApplicability(value: unknown): CheckApplicability {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Adapter returned invalid applicability");
  }
  const candidate = value as Record<string, unknown>;
  const applies = candidate.applies;
  if (applies === false) {
    const reason = candidate.reason;
    if (
      typeof reason !== "string" ||
      reason.length === 0 ||
      reason.trim() !== reason ||
      /[\u0000-\u001f\u007f]/u.test(reason)
    ) {
      throw new TypeError("Adapter returned an invalid skip reason");
    }
    return Object.freeze({
      applies,
      reason: displayProse(reason, "skip reason"),
    });
  }
  if (applies !== true) {
    throw new TypeError("Adapter returned invalid applicability");
  }
  const executionClass = candidate.executionClass;
  const requiresBaseline = candidate.requiresBaseline;
  const rawTargets = candidate.targets;
  const rawDisclosure = candidate.networkDisclosure;
  if (
    (executionClass !== "lightweight" &&
      executionClass !== "project-analysis" &&
      executionClass !== "network") ||
    typeof requiresBaseline !== "boolean" ||
    !Array.isArray(rawTargets)
  ) {
    throw new TypeError("Adapter returned invalid applicability");
  }
  const targets = Object.freeze(
    rawTargets
      .map((target) => sanitizeCheckTarget(target as CheckTarget))
      .sort((left, right) => compareCodeUnits(left.id, right.id)),
  );
  let networkDisclosure:
    | {
        readonly services: readonly string[];
        readonly metadata: readonly string[];
      }
    | undefined;
  if (rawDisclosure !== undefined) {
    if (
      executionClass !== "network" ||
      typeof rawDisclosure !== "object" ||
      rawDisclosure === null
    ) {
      throw new TypeError("Adapter returned invalid network disclosure");
    }
    const disclosure = rawDisclosure as Record<string, unknown>;
    if (
      !Array.isArray(disclosure.services) ||
      !Array.isArray(disclosure.metadata)
    ) {
      throw new TypeError("Adapter returned invalid network disclosure");
    }
    const services = Object.freeze(
      disclosure.services.map((service) =>
        displayProse(service, "network service"),
      ),
    );
    const metadata = Object.freeze(
      disclosure.metadata.map((field) =>
        displayProse(field, "network metadata"),
      ),
    );
    if (services.length === 0 || metadata.length === 0) {
      throw new TypeError("Adapter returned invalid network disclosure");
    }
    networkDisclosure = Object.freeze({ services, metadata });
  }
  return Object.freeze({
    applies,
    executionClass,
    requiresBaseline,
    targets,
    ...(networkDisclosure === undefined ? {} : { networkDisclosure }),
  });
}

export async function dispatchChecks(
  adapters: readonly CheckAdapter[],
  context: DispatchContext,
  options: DispatchOptions = {},
): Promise<CheckExecutionResult[]> {
  const clock = options.clock ?? performance.now.bind(performance);
  const emit = (event: ScanEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observers are display-only and must not change scan execution.
    }
  };
  const limits = {
    lightweight: pLimit(4),
    "project-analysis": pLimit(1),
    network: pLimit(1),
  } as const;
  const adapterContext = adapterBaseContext(context);

  const scheduled: Promise<CheckExecutionResult>[] = [];
  const adapterSnapshots = adapters.map(snapshotAdapter);
  for (const snapshot of adapterSnapshots) {
    if (!snapshot.valid) {
      scheduled.push(
        Promise.resolve(executionResult(incomplete(snapshot.id, 0), null)),
      );
      continue;
    }
    const adapter = snapshot.adapter;
    if (!mayBeEnabled(context, adapter.id)) {
      continue;
    }

    let inspectPolicy: ResolvedCheckPolicy | undefined;
    try {
      inspectPolicy = inspectionPolicy(context, adapter.id);
    } catch {
      scheduled.push(
        Promise.resolve(executionResult(incomplete(adapter.id, 0), null)),
      );
      continue;
    }
    if (inspectPolicy === undefined) continue;
    const inspectExecutionPolicy = immutablePolicy(inspectPolicy);
    let applicability;
    try {
      applicability = snapshotApplicability(
        await Reflect.apply(adapter.inspect, undefined, [
          inspectionContext(adapterContext, adapter.id, inspectPolicy),
        ]),
      );
    } catch {
      scheduled.push(
        Promise.resolve(executionResult(incomplete(adapter.id, 0), null)),
      );
      continue;
    }

    if (!applicability.applies) {
      scheduled.push(
        Promise.resolve(
          executionResult(
            {
              checkId: adapter.id,
              status: "skipped",
              durationMs: 0,
              findings: [],
              skipReason: applicability.reason,
            },
            inspectExecutionPolicy,
          ),
        ),
      );
      continue;
    }

    const targets = applicability.targets;
    if (targets.length === 0) {
      scheduled.push(
        Promise.resolve(executionResult(incomplete(adapter.id, 0), null)),
      );
      continue;
    }
    for (const target of targets) {
      let policy: ResolvedCheckPolicy;
      try {
        policy = resolveTargetPolicy(
          context.config,
          adapter.id as CheckId,
          target,
          context.targetInspection,
        );
      } catch {
        const queuedAt = clock();
        emit({
          type: "check-queued",
          checkId: adapter.id,
          target: target.id,
          timestamp: queuedAt,
        });
        const startedAt = clock();
        emit({
          type: "check-running",
          checkId: adapter.id,
          target: target.id,
          timestamp: startedAt,
        });
        const result = incomplete(adapter.id, 0, target.id);
        const execution = executionResult(result, null, target);
        emit({
          type: "check-completed",
          checkId: adapter.id,
          target: target.id,
          timestamp: clock(),
          result: sanitizeCheckResult(result),
        });
        scheduled.push(Promise.resolve(execution));
        continue;
      }
      if (policy.severity === "off") continue;
      const executionPolicy = immutablePolicy(policy);

      if (applicability.networkDisclosure !== undefined) {
        emit({
          type: "network-disclosure",
          checkId: adapter.id,
          target: target.id,
          timestamp: clock(),
          services: applicability.networkDisclosure.services,
          metadata: applicability.networkDisclosure.metadata,
        });
      }

      emit({
        type: "check-queued",
        checkId: adapter.id,
        target: target.id,
        timestamp: clock(),
      });
      const limit = limiterFor(applicability.executionClass, limits);
      scheduled.push(
        limit(async () => {
          const started = clock();
          emit({
            type: "check-running",
            checkId: adapter.id,
            target: target.id,
            timestamp: started,
          });
          let result: CheckResult;
          try {
            const runContext = scopedContext(
              adapterContext,
              adapter.id,
              target,
              executionPolicy,
            );
            const attributionContext: CheckRunContext = {
              ...context,
              target,
              policy: executionPolicy,
            };
            const adapterResult =
              adapter.output === "observations"
                ? await observationCheckResult(
                    adapter.id,
                    await collectObservations(adapter, runContext, options),
                    attributionContext,
                    applicability.requiresBaseline,
                  )
                : await Reflect.apply(adapter.runLegacy, undefined, [
                    runContext,
                  ]);
            result = sanitizeCheckResult(adapterResult, {
              checkId: adapter.id,
              target: target.id,
              durationMs: Math.max(0, clock() - started),
            });
          } catch {
            result = incomplete(
              adapter.id,
              Math.max(0, clock() - started),
              target.id,
            );
          }
          const displayResult =
            displayResultForPolicy(result, executionPolicy) ??
            sanitizeCheckResult(result);
          emit({
            type: "check-completed",
            checkId: adapter.id,
            target: target.id,
            timestamp: clock(),
            result: sanitizeCheckResult(displayResult),
          });
          return executionResult(result, executionPolicy, target);
        }),
      );
    }
  }

  return (await Promise.all(scheduled)).sort(compareResults);
}
