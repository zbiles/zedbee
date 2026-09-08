import pLimit from "p-limit";
import {
  CHECK_IDS,
  type CheckId,
  type ResolvedCheckPolicy,
} from "../config/schema.js";
import { type FilePolicyResolver } from "../config/file-policy.js";
import type { CheckResult } from "../core/types.js";
import type { CheckFixCandidate } from "../fixes/types.js";
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
  CheckFixProvider,
} from "./adapter.js";
import type { ScanEvent } from "./events.js";
import { observationCheckResult } from "./observation-result.js";
import { sanitizeCheckResult } from "./sanitize-result.js";
import { sanitizeCheckTarget } from "./sanitize-target.js";
import { incompleteResult } from "./incomplete-result.js";
import { CheckIncompleteError } from "./incomplete-error.js";
import { AnalyzerJobError } from "./diagnostics.js";
import type { ChangeSet, ChangedFile } from "../git/change-set.js";
import type { RepositoryInspection } from "../inspection/types.js";
import type {
  ResolvedConfig,
  ResolvedCheckPolicyPatch,
  ResolvedPolicyOverride,
} from "../config/schema.js";
import { displayResultForPolicy } from "../policy/evaluate.js";
import { compareCodeUnits } from "../core/compare.js";
import { displayLabel, displayProse } from "../core/display-text.js";
import {
  createObservationCacheKeyBuilder,
  effectiveBehaviorFingerprint,
} from "../cache/key.js";
import { observationCacheEngineIdentity } from "./engine-identity.js";
import { isCacheableObservationCheck } from "./metadata.js";
import {
  sanitizeCacheableObservationSet,
  type ObservationCache,
} from "../cache/store.js";
import { validateDependencyInputs } from "../cache/captured-dependencies.js";
import {
  resolveInspectionPolicy,
  resolveScheduledTargetPolicy,
} from "./policy-scheduling.js";
import {
  immutableConfigurationSnapshot,
  snapshotManagedPolicy,
} from "../config/settings-registry.js";
import { sanitizeFixCandidates } from "../fixes/sanitize.js";

export interface DispatchOptions {
  clock?: () => number;
  onEvent?: (event: ScanEvent) => void;
  cache?: ObservationCache;
  cacheEngineIdentity?: (checkId: string) => string | undefined;
  /** Invoke adapter fix providers after staged findings receive policy filtering. */
  collectFixes?: boolean;
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

type DispatchContext = InspectionContext &
  Pick<CheckRunContext, "snapshots" | "signal"> & {
    readonly policyForFile: FilePolicyResolver;
  };
type TrustedDispatchContext = DispatchContext;

const CHECK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  formatting: "Formatting",
  lint: "Lint",
  types: "TypeScript",
  cyclomaticComplexity: "Cyclomatic complexity",
  readabilityComplexity: "Readability complexity",
  structuralSecurity: "Structural security",
  secrets: "Secrets",
  duplication: "Duplication",
  dependencyArchitecture: "Dependency architecture",
  deadCode: "Dead code",
  reactCorrectness: "React correctness",
  reactAccessibility: "React accessibility",
  vulnerabilities: "Vulnerabilities",
});

function checkLabel(checkId: string): string {
  return CHECK_LABELS[checkId] ?? checkId;
}

function immutablePolicy<
  T extends ResolvedCheckPolicy | ResolvedCheckPolicyPatch,
>(checkId: string, policy: Readonly<T>): Readonly<T> {
  return CHECK_IDS.includes(checkId as CheckId)
    ? snapshotManagedPolicy(checkId as CheckId, policy)
    : immutableConfigurationSnapshot(policy);
}

function executionResult(
  result: CheckResult,
  policy: Readonly<ResolvedCheckPolicy> | null,
  target?: CheckTarget,
  policyForFile?: FilePolicyResolver,
  fixCandidates?: readonly CheckFixCandidate[],
): CheckExecutionResult {
  return {
    result: sanitizeCheckResult(result),
    ...(target === undefined ? {} : { target }),
    policy,
    ...(policyForFile === undefined ? {} : { policyForFile }),
    ...(fixCandidates === undefined ? {} : { fixCandidates }),
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
  return resolveInspectionPolicy(context.config, checkId as CheckId);
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
          patch === undefined ? undefined : immutablePolicy(id, patch),
        ]),
      ),
    ),
    configurationOrigins: snapshotConfigurationOrigins(
      override.configurationOrigins,
    ),
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

async function collectObservations(
  adapter: Extract<AdapterSnapshot, { output: "observations" }>,
  runContext: CheckRunContext,
  cachePolicy: Readonly<ResolvedCheckPolicy>,
  behavior: unknown,
  options: DispatchOptions,
  cacheKeyFor: ReturnType<typeof createObservationCacheKeyBuilder>,
): Promise<CheckObservationSet> {
  if (
    !isCacheableObservationCheck(adapter.id) ||
    (options.cache === undefined && options.cacheEngineIdentity === undefined)
  ) {
    return Reflect.apply(adapter.collect, undefined, [runContext]);
  }
  const engineIdentity = (
    options.cacheEngineIdentity ?? observationCacheEngineIdentity
  )(adapter.id);
  if (engineIdentity === undefined) {
    return Reflect.apply(adapter.collect, undefined, [runContext]);
  }
  let cacheKey: string | undefined;
  if (options.cache !== undefined && engineIdentity !== undefined) {
    try {
      cacheKey = await cacheKeyFor({
        checkId: adapter.id,
        engineIdentity,
        policy: cachePolicy,
        checkTarget: runContext.target,
        relevantConfig: {
          schemaVersion: runContext.config.schemaVersion,
          behavior,
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
        ((adapter.id !== "lint" && adapter.id !== "types") ||
          validateDependencyInputs(cached.dependencyInputs, runContext))
      ) {
        return sanitizeCacheableObservationSet(cached);
      }
    } catch {
      cacheKey = undefined;
    }
  }

  const collected = await Reflect.apply(adapter.collect, undefined, [
    runContext,
  ]);
  if (
    cacheKey !== undefined &&
    options.cache !== undefined &&
    !runContext.signal.aborted &&
    ((adapter.id !== "lint" && adapter.id !== "types") ||
      validateDependencyInputs(collected.dependencyInputs, runContext))
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
      targetRef: context.snapshots.targetRef,
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
  context: TrustedDispatchContext,
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
      planFixes?: CheckFixProvider;
    }>
  | Readonly<{
      id: "formatting";
      output: "legacy-check-result";
      inspect: LegacyCheckResultAdapter["inspect"];
      runLegacy: LegacyCheckResultAdapter["runLegacy"];
      planFixes?: CheckFixProvider;
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
    const planFixes = candidate.planFixes;
    if (typeof inspect !== "function") {
      throw new TypeError("Adapter returned an invalid inspect function");
    }
    if (planFixes !== undefined && typeof planFixes !== "function") {
      throw new TypeError("Adapter returned an invalid fix provider");
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
          ...(planFixes === undefined
            ? {}
            : { planFixes: planFixes as CheckFixProvider }),
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
          ...(planFixes === undefined
            ? {}
            : { planFixes: planFixes as CheckFixProvider }),
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
    lightweight: pLimit(2),
    "project-analysis": pLimit(1),
    network: pLimit(1),
  } as const;
  const overallLimit = pLimit(2);
  // Default installed metadata is reused only within this dispatch. Preserve
  // injected resolvers' per-collection behavior and avoid all reads without cache.
  const identities = new Map<string, string | undefined>();
  const executionOptions: DispatchOptions =
    options.cache === undefined || options.cacheEngineIdentity !== undefined
      ? options
      : {
          ...options,
          cacheEngineIdentity(checkId) {
            if (!identities.has(checkId))
              identities.set(checkId, observationCacheEngineIdentity(checkId));
            return identities.get(checkId);
          },
        };
  const adapterContext: TrustedDispatchContext = adapterBaseContext(context);
  const cacheKeyFor = createObservationCacheKeyBuilder(
    adapterContext.snapshots.baselineDir,
    adapterContext.snapshots.targetDir,
    adapterContext.snapshots.targetRef === "index"
      ? {
          mode: "index",
          baseline: adapterContext.snapshots.baselineRef,
          target: "index",
        }
      : {
          mode: "base",
          baseline: adapterContext.snapshots.baselineRef,
          target: adapterContext.snapshots.targetRef,
        },
  );

  const scheduled: Promise<CheckExecutionResult>[] = [];
  const adapterSnapshots = adapters.map(snapshotAdapter);
  for (const snapshot of adapterSnapshots) {
    if (!snapshot.valid) {
      const label = checkLabel(snapshot.id);
      scheduled.push(
        Promise.resolve(
          executionResult(
            incompleteResult({
              checkId: snapshot.id,
              durationMs: 0,
              code: "ADAPTER_INVALID",
              message: `${label} has an invalid adapter definition.`,
              remediation:
                "Check the installed Zedbee version and run zedbee doctor.",
            }),
            null,
          ),
        ),
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
      const label = checkLabel(adapter.id);
      scheduled.push(
        Promise.resolve(
          executionResult(
            incompleteResult({
              checkId: adapter.id,
              durationMs: 0,
              code: "POLICY_RESOLUTION_FAILED",
              message: `${label} could not resolve its repository policy.`,
              remediation:
                "Check the repository configuration and run zedbee doctor.",
            }),
            null,
          ),
        ),
      );
      continue;
    }
    if (inspectPolicy === undefined) continue;
    const inspectExecutionPolicy = immutablePolicy(adapter.id, inspectPolicy);
    let applicability;
    try {
      applicability = snapshotApplicability(
        await Reflect.apply(adapter.inspect, undefined, [
          inspectionContext(adapterContext, adapter.id, inspectPolicy),
        ]),
      );
    } catch {
      const label = checkLabel(adapter.id);
      scheduled.push(
        Promise.resolve(
          executionResult(
            incompleteResult({
              checkId: adapter.id,
              durationMs: 0,
              code: "ADAPTER_INSPECTION_FAILED",
              message: `${label} could not determine whether it applies.`,
              remediation:
                "Check the repository configuration and run zedbee doctor.",
            }),
            null,
          ),
        ),
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
      const label = checkLabel(adapter.id);
      scheduled.push(
        Promise.resolve(
          executionResult(
            incompleteResult({
              checkId: adapter.id,
              durationMs: 0,
              code: "ADAPTER_TARGETS_MISSING",
              message: `${label} could not determine which selected targets to analyze.`,
              remediation:
                "Check the selected paths and repository configuration, then retry.",
            }),
            null,
          ),
        ),
      );
      continue;
    }
    for (const target of targets) {
      let policy: ResolvedCheckPolicy;
      try {
        const scheduledPolicy = resolveScheduledTargetPolicy(
          context.config,
          adapter.id as CheckId,
          target,
          context.targetInspection,
          context.changeSet,
          adapterContext.policyForFile,
        );
        if (scheduledPolicy === undefined) continue;
        policy = scheduledPolicy;
      } catch {
        const label = checkLabel(adapter.id);
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
        const result = incompleteResult({
          checkId: adapter.id,
          target: target.id,
          durationMs: 0,
          code: "TARGET_POLICY_FAILED",
          message: `${label} could not resolve policy for ${target.id}.`,
          remediation: "Check the target configuration and run zedbee doctor.",
        });
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
      const executionPolicy = immutablePolicy(adapter.id, policy);

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
      const classLimit = limiterFor(applicability.executionClass, limits);
      const limit = (run: () => Promise<CheckExecutionResult>) =>
        classLimit(() => overallLimit(run));
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
          let runContext: CheckRunContext | undefined;
          const durationMs = (): number => Math.max(0, clock() - started);
          const label = checkLabel(adapter.id);
          try {
            adapterContext.signal.throwIfAborted();
            runContext = scopedContext(
              adapterContext,
              adapter.id,
              target,
              executionPolicy,
            );
            const attributionContext: CheckRunContext = {
              ...adapterContext,
              target,
              policy: executionPolicy,
            };
            let adapterResult: CheckResult | undefined;
            if (adapter.output === "observations") {
              const checkId = adapter.id as CheckId;
              const observations = await collectObservations(
                adapter,
                runContext,
                FILE_BEHAVIOR_CHECKS.has(checkId)
                  ? adapterContext.config.checks[checkId]
                  : runContext.policy,
                CHECK_IDS.includes(checkId)
                  ? effectiveBehaviorFingerprint(
                      adapterContext.config,
                      checkId,
                      cacheBehaviorPaths(
                        checkId,
                        target,
                        adapterContext.baselineInspection,
                        adapterContext.targetInspection,
                      ),
                      adapterContext.changeSet,
                    )
                  : undefined,
                executionOptions,
                cacheKeyFor,
              );
              try {
                adapterResult = await observationCheckResult(
                  adapter.id,
                  observations,
                  attributionContext,
                  applicability.requiresBaseline,
                );
              } catch {
                adapterResult = undefined;
              }
            } else {
              adapterResult = await Reflect.apply(
                adapter.runLegacy,
                undefined,
                [runContext],
              );
            }
            if (adapterResult === undefined) {
              result = incompleteResult({
                checkId: adapter.id,
                target: target.id,
                durationMs: durationMs(),
                code: "ADAPTER_RESULT_INVALID",
                message: `${label} returned an invalid result for ${target.id === "." ? "the repository root" : target.id}.`,
                remediation:
                  "Run zedbee doctor and update Zedbee before retrying.",
              });
            } else {
              try {
                result = sanitizeCheckResult(adapterResult, {
                  checkId: adapter.id,
                  target: target.id,
                  durationMs: durationMs(),
                });
              } catch {
                result = incompleteResult({
                  checkId: adapter.id,
                  target: target.id,
                  durationMs: durationMs(),
                  code: "ADAPTER_RESULT_INVALID",
                  message: `${label} returned an invalid result for ${target.id === "." ? "the repository root" : target.id}.`,
                  remediation:
                    "Run zedbee doctor and update Zedbee before retrying.",
                });
              }
            }
          } catch (error) {
            result =
              error instanceof CheckIncompleteError
                ? incompleteResult({
                    checkId: adapter.id,
                    target: target.id,
                    durationMs: durationMs(),
                    code: error.code,
                    message: error.message,
                    remediation: error.remediation,
                    ...(error.diagnostic === undefined
                      ? {}
                      : { diagnostic: error.diagnostic }),
                    ...(error.path === undefined ? {} : { path: error.path }),
                    ...(error.paths === undefined
                      ? {}
                      : { paths: error.paths }),
                    ...(error.snapshot === undefined
                      ? {}
                      : { snapshot: error.snapshot }),
                    ...(error.projectPaths === undefined
                      ? {}
                      : { projectPaths: error.projectPaths }),
                    ...(error.disposition === undefined
                      ? {}
                      : { disposition: error.disposition }),
                  })
                : incompleteResult({
                    checkId: adapter.id,
                    target: target.id,
                    durationMs: durationMs(),
                    code: "ADAPTER_EXECUTION_FAILED",
                    ...(error instanceof AnalyzerJobError
                      ? { diagnostic: error.diagnostic }
                      : {}),
                    message: `${label} could not analyze ${target.id === "." ? "the repository root" : target.id}.`,
                    remediation:
                      "Check the analyzer installation and selected input, then retry.",
                  });
          }
          const policyDisplayResult = displayResultForPolicy(
            result,
            executionPolicy,
            adapterContext.policyForFile,
          );
          let displayResult =
            policyDisplayResult ?? sanitizeCheckResult(result);
          let fixCandidates: readonly CheckFixCandidate[] | undefined;
          if (
            options.collectFixes === true &&
            adapter.planFixes !== undefined &&
            policyDisplayResult?.status === "completed" &&
            policyDisplayResult.findings.length > 0 &&
            runContext !== undefined
          ) {
            try {
              fixCandidates = sanitizeFixCandidates(
                await Reflect.apply(adapter.planFixes, undefined, [
                  runContext,
                  policyDisplayResult.findings,
                ]),
                {
                  checkId: adapter.id,
                  findingIds: policyDisplayResult.findings.map(
                    (finding) => finding.id,
                  ),
                },
              );
            } catch (error) {
              result = incompleteResult({
                checkId: adapter.id,
                target: target.id,
                durationMs: durationMs(),
                code: "FIX_PROVIDER_FAILED",
                ...(error instanceof AnalyzerJobError ||
                error instanceof CheckIncompleteError
                  ? error.diagnostic === undefined
                    ? {}
                    : { diagnostic: error.diagnostic }
                  : {}),
                message: `${label} could not prepare managed fixes.`,
                remediation:
                  "Update Zedbee or inspect the managed rule compatibility before retrying.",
              });
              displayResult =
                displayResultForPolicy(
                  result,
                  executionPolicy,
                  adapterContext.policyForFile,
                ) ?? sanitizeCheckResult(result);
            }
          }
          emit({
            type: "check-completed",
            checkId: adapter.id,
            target: target.id,
            timestamp: clock(),
            result: sanitizeCheckResult(displayResult),
          });
          return executionResult(
            result,
            executionPolicy,
            target,
            adapterContext.policyForFile,
            fixCandidates,
          );
        }),
      );
    }
  }

  return (await Promise.all(scheduled)).sort(compareResults);
}
