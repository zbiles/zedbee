import { dirname } from "node:path";
import type { CheckAdapter, CheckExecutionResult } from "../checks/adapter.js";
import {
  cyclomaticComplexityAdapter,
  readabilityComplexityAdapter,
} from "../checks/complexity/adapter.js";
import { deadCodeAdapter } from "../checks/dead-code/adapter.js";
import { dependencyArchitectureAdapter } from "../checks/dependency-architecture/adapter.js";
import { dispatchChecks, type DispatchOptions } from "../checks/dispatcher.js";
import { duplicationAdapter } from "../checks/duplication/adapter.js";
import { lintAdapter } from "../checks/eslint/lint-adapter.js";
import type { ScanEvent } from "../checks/events.js";
import { prettierAdapter } from "../checks/prettier/adapter.js";
import { reactAccessibilityAdapter } from "../checks/react/accessibility-adapter.js";
import { reactCorrectnessAdapter } from "../checks/react/correctness-adapter.js";
import { secretsAdapter } from "../checks/secrets/adapter.js";
import { structuralSecurityAdapter } from "../checks/structural-security/adapter.js";
import { typescriptAdapter } from "../checks/typescript/adapter.js";
import { vulnerabilitiesAdapter } from "../checks/vulnerabilities/adapter.js";
import { ConfigError, loadConfig } from "../config/load-config.js";
import type { ResolvedConfig } from "../config/schema.js";
import { summarizeChecks } from "../core/summarize.js";
import { readStagedChangeSet, type ChangeSet } from "../git/change-set.js";
import { GitClient } from "../git/client.js";
import {
  buildSnapshotPair,
  SnapshotConstructionCleanupError,
  SnapshotError,
  type SnapshotPair,
} from "../git/snapshot.js";
import { validateReportableSnapshotPath } from "../git/snapshot-path.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import type { RepositoryInspection } from "../inspection/types.js";
import { evaluatePolicy, type PolicyDecision } from "../policy/evaluate.js";
import type { NetworkDisclosure, ScanReport } from "./report.js";
import {
  createIncompleteReport,
  withCleanupFailure,
  withUnreportableCleanupFailure,
  type ScanFailureInput,
  type ScanReportContext,
} from "./incomplete-report.js";
import type {
  ReportingSurface,
  SourceExcerptOverride,
} from "./reporting-options.js";
import { shouldIncludeSourceExcerpts } from "./reporting-options.js";
import { enrichSourceExcerpts, omitSourceExcerpts } from "./source-excerpts.js";
import {
  defaultObservationCacheRoot,
  ObservationCacheStore,
  type ObservationCache,
} from "../cache/store.js";

export interface RunScanDependencies {
  loadConfig(
    repositoryRoot: string,
    configPath?: string,
  ): Promise<ResolvedConfig>;
  createGitClient(repositoryRoot: string): GitClient;
  readChangeSet(git: GitClient): Promise<ChangeSet>;
  buildSnapshots(repositoryRoot: string, git: GitClient): Promise<SnapshotPair>;
  inspectRepository(snapshotRoot: string): Promise<RepositoryInspection>;
  baselineForEmptyChange(git: GitClient): Promise<"HEAD" | null>;
  dispatch: typeof dispatchChecks;
  evaluate(
    results: readonly CheckExecutionResult[],
    config: ResolvedConfig,
  ): PolicyDecision;
  adapters: readonly CheckAdapter[];
  now(): Date;
  clock(): number;
  createObservationCache?(): ObservationCache;
}

export interface RunScanOptions {
  repositoryRoot: string;
  configPath?: string;
  reportingSurface?: ReportingSurface;
  sourceExcerpts?: SourceExcerptOverride;
  signal?: AbortSignal;
  onEvent?: (event: ScanEvent) => void;
  dependencies?: RunScanDependencies;
  cache?: ObservationCache | false;
}

export const DEFAULT_CHECK_ADAPTERS: readonly CheckAdapter[] = Object.freeze([
  prettierAdapter,
  lintAdapter,
  typescriptAdapter,
  cyclomaticComplexityAdapter,
  readabilityComplexityAdapter,
  structuralSecurityAdapter,
  secretsAdapter,
  duplicationAdapter,
  dependencyArchitectureAdapter,
  deadCodeAdapter,
  reactCorrectnessAdapter,
  reactAccessibilityAdapter,
  vulnerabilitiesAdapter,
]);

const DEFAULT_DEPENDENCIES: RunScanDependencies = {
  loadConfig,
  createGitClient: (repositoryRoot) => new GitClient(repositoryRoot),
  readChangeSet: readStagedChangeSet,
  buildSnapshots: buildSnapshotPair,
  inspectRepository,
  async baselineForEmptyChange(git) {
    return (await git.tryRun(["rev-parse", "--verify", "HEAD"])).exitCode === 0
      ? "HEAD"
      : null;
  },
  dispatch: dispatchChecks,
  evaluate: evaluatePolicy,
  adapters: DEFAULT_CHECK_ADAPTERS,
  now: () => new Date(),
  clock: () => performance.now(),
  createObservationCache: () =>
    new ObservationCacheStore({ root: defaultObservationCacheRoot() }),
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

type ActiveScanPhase =
  | "configuration"
  | "change-discovery"
  | "baseline-resolution"
  | "snapshot-construction"
  | "lfs-pointer"
  | "baseline-inspection"
  | "target-inspection"
  | "dispatch"
  | "policy-evaluation";

const PHASE_FAILURES = {
  configuration: {
    code: "CONFIGURATION_FAILED",
    message: "Zedbee could not load the configuration.",
    remediation: "Check the Zedbee configuration and run the scan again.",
  },
  "change-discovery": {
    code: "CHANGE_DISCOVERY_FAILED",
    message: "Zedbee could not read the staged changes.",
    remediation: "Resolve the Git index problem and run the scan again.",
  },
  "baseline-resolution": {
    code: "BASELINE_RESOLUTION_FAILED",
    message: "Zedbee could not resolve the repository baseline.",
    remediation: "Check the Git repository state and run the scan again.",
  },
  "snapshot-construction": {
    code: "SNAPSHOT_CONSTRUCTION_FAILED",
    message: "Zedbee could not construct the staged snapshots.",
    remediation:
      "Check the Git index and temporary-directory permissions, then retry.",
  },
  "lfs-pointer": {
    code: "GIT_LFS_POINTER",
    message: "Zedbee cannot inspect a staged Git LFS pointer.",
    remediation:
      "Materialize the Git LFS object for this path, stage it again, and rerun the scan.",
  },
  "baseline-inspection": {
    code: "BASELINE_INSPECTION_FAILED",
    message: "Zedbee could not inspect the baseline snapshot.",
    remediation:
      "Check the baseline repository metadata and run the scan again.",
  },
  "target-inspection": {
    code: "TARGET_INSPECTION_FAILED",
    message: "Zedbee could not inspect the staged snapshot.",
    remediation: "Check the staged repository metadata and run the scan again.",
  },
  dispatch: {
    code: "CHECK_DISPATCH_FAILED",
    message: "Zedbee could not dispatch the configured checks.",
    remediation: "Review the check diagnostics, run zedbee doctor, and retry.",
  },
  "policy-evaluation": {
    code: "POLICY_EVALUATION_FAILED",
    message: "Zedbee could not evaluate the scan policy.",
    remediation: "Check the Zedbee policy configuration and retry.",
  },
} as const satisfies Readonly<Record<ActiveScanPhase, ScanFailureInput>>;

function phaseFailure(
  error: unknown,
  phase: ActiveScanPhase,
): ScanFailureInput {
  if (phase === "configuration" && error instanceof ConfigError) {
    return error.code === "CONFIG_UNSUPPORTED"
      ? {
          code: error.code,
          message: "Zedbee found an unsupported configuration file.",
          remediation:
            "Replace it with .zedbeerc.jsonc and run the scan again.",
        }
      : {
          code: error.code,
          message: "Zedbee could not load a valid configuration.",
          remediation: "Fix the Zedbee configuration and run the scan again.",
        };
  }
  if (phase === "snapshot-construction" && error instanceof SnapshotError) {
    if (error.code === "UNRESOLVED_INDEX") {
      return {
        code: error.code,
        message: "Zedbee cannot scan an index with unresolved entries.",
        remediation: "Resolve the staged merge entries and run the scan again.",
      };
    }
    if (error.code === "INVALID_TEMP_PATH") {
      return {
        code: error.code,
        message: "Zedbee refused an unsafe temporary snapshot path.",
        remediation:
          "Verify the system temporary directory and run the scan again.",
      };
    }
    return PHASE_FAILURES[phase];
  }
  return PHASE_FAILURES[phase];
}

function dispatchOptions(
  onEvent: RunScanOptions["onEvent"],
  networkDisclosures: NetworkDisclosure[],
  cache: ObservationCache | undefined,
): DispatchOptions {
  return {
    ...(cache === undefined ? {} : { cache }),
    onEvent(event) {
      if (event.type === "network-disclosure") {
        networkDisclosures.push({
          checkId: event.checkId,
          target: event.target,
          services: Object.freeze([...event.services]),
          metadata: Object.freeze([...event.metadata]),
        });
      }
      onEvent?.(event);
    },
  };
}

export async function runScan(options: RunScanOptions): Promise<ScanReport> {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const startedAt = dependencies.now().toISOString();
  const started = dependencies.clock();
  let snapshots: SnapshotPair | undefined;
  let baseline: "HEAD" | null = null;
  let stagedFileCount: number | null = null;
  const networkDisclosures: NetworkDisclosure[] = [];
  let activePhase: ActiveScanPhase = "configuration";
  let report: ScanReport | undefined;
  let abortedError: unknown;
  let shouldRethrow = false;

  const reportContext = (): ScanReportContext => ({
    repositoryRoot: options.repositoryRoot,
    baseline,
    stagedFileCount,
    startedAt,
    durationMs: Math.max(0, dependencies.clock() - started),
    networkDisclosures,
  });

  try {
    activePhase = "configuration";
    const config = await dependencies.loadConfig(
      options.repositoryRoot,
      options.configPath,
    );
    activePhase = "change-discovery";
    const git = dependencies.createGitClient(options.repositoryRoot);
    const changeSet = await dependencies.readChangeSet(git);
    stagedFileCount = changeSet.files.size;

    if (changeSet.isEmpty) {
      activePhase = "baseline-resolution";
      baseline = await dependencies.baselineForEmptyChange(git);
      report = {
        schemaVersion: 1,
        outcome: "pass",
        exitCode: 0,
        repositoryRoot: options.repositoryRoot,
        baseline,
        target: "index",
        stagedFileCount,
        startedAt,
        durationMs: Math.max(0, dependencies.clock() - started),
        networkDisclosures,
        summary: summarizeChecks([]),
        checks: [],
      };
    } else {
      activePhase = "snapshot-construction";
      snapshots = await dependencies.buildSnapshots(
        options.repositoryRoot,
        git,
      );
      baseline = snapshots.baselineRef;
      const lfsPointer = snapshots.unsupportedEntries.find(
        ({ kind }) => kind === "git-lfs-pointer",
      );
      if (lfsPointer !== undefined) {
        activePhase = "lfs-pointer";
        report = createIncompleteReport(reportContext(), {
          ...PHASE_FAILURES[activePhase],
          path: lfsPointer.path,
        });
      } else {
        activePhase = "baseline-inspection";
        const baselineInspection = await dependencies.inspectRepository(
          snapshots.baselineDir,
        );
        activePhase = "target-inspection";
        const targetInspection = await dependencies.inspectRepository(
          snapshots.targetDir,
        );
        const controller =
          options.signal === undefined ? new AbortController() : undefined;
        const signal = options.signal ?? controller!.signal;
        activePhase = "dispatch";
        const results = await dependencies.dispatch(
          dependencies.adapters,
          {
            repositoryRoot: options.repositoryRoot,
            changeSet,
            config,
            snapshots,
            baselineInspection,
            targetInspection,
            signal,
          },
          dispatchOptions(
            options.onEvent,
            networkDisclosures,
            options.cache === false
              ? undefined
              : (options.cache ?? dependencies.createObservationCache?.()),
          ),
        );
        activePhase = "policy-evaluation";
        const decision = dependencies.evaluate(results, config);
        const reportedResults = shouldIncludeSourceExcerpts(
          config.reporting.sourceExcerpts,
          options.reportingSurface,
          options.sourceExcerpts,
        )
          ? await enrichSourceExcerpts(decision.results, targetInspection)
          : omitSourceExcerpts(decision.results);
        report = {
          schemaVersion: 1,
          outcome: decision.outcome,
          exitCode: decision.exitCode,
          repositoryRoot: options.repositoryRoot,
          baseline,
          target: "index",
          stagedFileCount,
          startedAt,
          durationMs: Math.max(0, dependencies.clock() - started),
          networkDisclosures,
          summary: summarizeChecks(reportedResults),
          checks: reportedResults,
        };
      }
    }
  } catch (error) {
    if (options.signal?.aborted === true) {
      abortedError = error;
      shouldRethrow = true;
    } else {
      const constructionCleanupFailure =
        error instanceof SnapshotConstructionCleanupError ? error : undefined;
      report = createIncompleteReport(
        reportContext(),
        phaseFailure(
          constructionCleanupFailure?.constructionError ?? error,
          activePhase,
        ),
      );
      if (constructionCleanupFailure !== undefined) {
        const durationMs = Math.max(0, dependencies.clock() - started);
        try {
          const snapshotRoot = validateReportableSnapshotPath(
            constructionCleanupFailure.temporaryPath ?? "",
          );
          report = withCleanupFailure(report, snapshotRoot, durationMs);
        } catch {
          report = withUnreportableCleanupFailure(report, durationMs);
        }
      }
    }
  }

  try {
    await snapshots?.cleanup();
  } catch {
    if (
      options.signal?.aborted !== true &&
      snapshots !== undefined &&
      report !== undefined
    ) {
      const durationMs = Math.max(0, dependencies.clock() - started);
      try {
        const snapshotRoot = validateReportableSnapshotPath(
          dirname(snapshots.targetDir),
        );
        report = withCleanupFailure(report, snapshotRoot, durationMs);
      } catch {
        report = withUnreportableCleanupFailure(report, durationMs);
      }
    }
  }

  if (!shouldRethrow && options.signal?.aborted === true) {
    abortedError = options.signal.reason;
    shouldRethrow = true;
  }

  if (shouldRethrow) throw abortedError;
  if (report === undefined) {
    throw new TypeError("Zedbee scan completed without a report.");
  }
  return deepFreeze(report);
}
