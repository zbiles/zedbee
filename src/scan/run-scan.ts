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
import {
  ConfigError,
  loadConfigFromCommit,
  loadConfigFromIndex,
} from "../config/load-config.js";
import { createFilePolicyResolver } from "../config/file-policy.js";
import type { ResolvedConfig } from "../config/schema.js";
import { EMPTY_AGENT_GUIDANCE } from "../reporting/agent-guidance.js";
import { summarizeChecks } from "../core/summarize.js";
import {
  addCommitLineRanges,
  addStagedLineRanges,
  addWholeFileLineRanges,
  discoverCommitChangeSet,
  discoverStagedChangeSet,
  readCommitChangeSet,
  readStagedChangeSet,
} from "../git/change-set.js";
import {
  BaseComparisonError,
  resolveBaseComparison,
  type BaseComparisonErrorCode,
} from "../git/base-comparison.js";
import { safeRequestedBase } from "../git/base-ref.js";
import { GitClient } from "../git/client.js";
import { GitCommandError } from "../git/errors.js";
import { resolveScanResourcePolicy } from "./resource-policy.js";
import {
  buildCommitSnapshotPair,
  buildSnapshotPair,
  countSnapshotFileLines,
  SnapshotConstructionCleanupError,
  SnapshotError,
  type SnapshotPair,
} from "../git/snapshot.js";
import { validateReportableSnapshotPath } from "../git/snapshot-path.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import type { RepositoryInspection } from "../inspection/types.js";
import { evaluatePolicy, type PolicyDecision } from "../policy/evaluate.js";
import type {
  NetworkDisclosure,
  ScanPresentationPolicy,
  ScanReport,
} from "./report.js";
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
import {
  shouldIncludeSourceExcerpts,
  shouldPersistSourceExcerpts,
} from "./reporting-options.js";
import { enrichSourceExcerpts, omitSourceExcerpts } from "./source-excerpts.js";
import { unsupportedEntryFailures } from "./unsupported-inputs.js";
import {
  sanitizeScanSourceIdentity,
  type ScanMode,
  type ScanSourceIdentity,
} from "./source-mode.js";
import {
  defaultObservationCacheRoot,
  ObservationCacheStore,
  type ObservationCache,
} from "../cache/store.js";

export interface RunScanDependencies {
  resolveBaseComparison: typeof resolveBaseComparison;
  loadIndexConfig: typeof loadConfigFromIndex;
  loadCommitConfig: typeof loadConfigFromCommit;
  createGitClient(
    repositoryRoot: string,
    options?: ConstructorParameters<typeof GitClient>[1],
  ): GitClient;
  readIndexChangeSet: typeof readStagedChangeSet;
  readCommitChangeSet: typeof readCommitChangeSet;
  discoverIndexChangeSet?: typeof discoverStagedChangeSet;
  discoverCommitChangeSet?: typeof discoverCommitChangeSet;
  addIndexLineRanges?: typeof addStagedLineRanges;
  addCommitLineRanges?: typeof addCommitLineRanges;
  buildIndexSnapshots: typeof buildSnapshotPair;
  buildCommitSnapshots: typeof buildCommitSnapshotPair;
  inspectRepository(snapshotRoot: string): Promise<RepositoryInspection>;
  baselineForEmptyChange(
    git: GitClient,
    signal?: AbortSignal,
  ): Promise<"HEAD" | null>;
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
  baseRef?: string;
  configPath?: string;
  reportingSurface?: ReportingSurface;
  sourceExcerpts?: SourceExcerptOverride;
  timeout?: string;
  noTimeout?: boolean;
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
  resolveBaseComparison,
  loadIndexConfig: loadConfigFromIndex,
  loadCommitConfig: loadConfigFromCommit,
  createGitClient: (repositoryRoot, options) =>
    new GitClient(repositoryRoot, options),
  readIndexChangeSet: readStagedChangeSet,
  readCommitChangeSet,
  discoverIndexChangeSet: discoverStagedChangeSet,
  discoverCommitChangeSet,
  addIndexLineRanges: addStagedLineRanges,
  addCommitLineRanges,
  buildIndexSnapshots: buildSnapshotPair,
  buildCommitSnapshots: buildCommitSnapshotPair,
  inspectRepository,
  async baselineForEmptyChange(git, signal) {
    return (
      await git.tryRun(
        ["rev-parse", "--verify", "HEAD"],
        signal === undefined ? {} : { signal },
      )
    ).exitCode === 0
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

const BASE_COMPARISON_FAILURES: Readonly<
  Record<BaseComparisonErrorCode, ScanFailureInput>
> = {
  BASE_REF_INVALID: {
    code: "BASE_REF_INVALID",
    message: "Zedbee refused an invalid requested base ref.",
    remediation:
      "Choose a non-empty display-safe base ref that does not begin with '-', then retry.",
  },
  BASE_REF_UNAVAILABLE: {
    code: "BASE_REF_UNAVAILABLE",
    message: "Zedbee could not resolve the requested base ref locally.",
    remediation:
      "Fetch the requested base ref or choose one available locally, then retry.",
  },
  TARGET_COMMIT_UNAVAILABLE: {
    code: "TARGET_COMMIT_UNAVAILABLE",
    message: "Zedbee could not resolve the target commit.",
    remediation: "Check out or create a valid target commit, then retry.",
  },
  MERGE_BASE_UNAVAILABLE: {
    code: "MERGE_BASE_UNAVAILABLE",
    message: "Zedbee could not find a merge base for the selected revisions.",
    remediation:
      "Fetch enough local history for both revisions or choose a base with shared history, then retry.",
  },
  MERGE_BASE_AMBIGUOUS: {
    code: "MERGE_BASE_AMBIGUOUS",
    message:
      "Zedbee found more than one merge base for the selected revisions.",
    remediation: "Choose a base with one unambiguous merge base, then retry.",
  },
  REVISION_OUTPUT_INVALID: {
    code: "REVISION_OUTPUT_INVALID",
    message: "Zedbee received invalid revision data from Git.",
    remediation:
      "Verify the local Git repository and Git executable, then retry.",
  },
};

function sourcePhaseFailure(
  phase: ActiveScanPhase,
  mode: ScanMode,
): ScanFailureInput {
  if (mode === "index") return PHASE_FAILURES[phase];
  if (phase === "change-discovery") {
    return {
      code: "CHANGE_DISCOVERY_FAILED",
      message: "Zedbee could not read the committed changes.",
      remediation:
        "Verify the selected commits and local Git objects, then retry.",
    };
  }
  if (phase === "snapshot-construction") {
    return {
      code: "SNAPSHOT_CONSTRUCTION_FAILED",
      message: "Zedbee could not construct the committed snapshots.",
      remediation:
        "Verify the selected commits, local Git objects, and temporary-directory permissions, then retry.",
    };
  }
  if (phase === "target-inspection") {
    return {
      code: "TARGET_INSPECTION_FAILED",
      message: "Zedbee could not inspect the committed target snapshot.",
      remediation:
        "Check the committed target repository metadata and run the scan again.",
    };
  }
  return PHASE_FAILURES[phase];
}

function phaseFailure(
  error: unknown,
  phase: ActiveScanPhase,
  mode: ScanMode,
): ScanFailureInput {
  if (error instanceof BaseComparisonError) {
    return BASE_COMPARISON_FAILURES[error.code];
  }
  if (error instanceof GitCommandError) {
    if (error.code === "GIT_OUTPUT_LIMIT_EXCEEDED") {
      return {
        code: error.code,
        message:
          "Zedbee stopped a Git command after it exceeded the configured output limit.",
        remediation:
          "Increase resources.git.outputLimitBytes and run the scan again.",
      };
    }
    if (error.code === "GIT_HARD_TIMEOUT") {
      return {
        code: error.code,
        message:
          "Zedbee stopped a Git command after it exceeded the configured hard timeout.",
        remediation:
          "Increase resources.git.hardTimeout or run zedbee scan with --no-timeout.",
      };
    }
  }
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
    if (error.code === "UNRESOLVED_INDEX" && mode === "index") {
      return {
        code: error.code,
        message: "Zedbee cannot scan an index with unresolved entries.",
        remediation: "Resolve the staged merge entries and run the scan again.",
      };
    }
    if (error.code === "INVALID_INDEX_PATH") {
      return mode === "index"
        ? {
            code: error.code,
            message: "Zedbee refused an invalid staged repository path.",
            remediation:
              "Repair or remove the invalid Git index entry and run the scan again.",
          }
        : {
            code: error.code,
            message: "Zedbee refused an invalid committed repository path.",
            remediation:
              "Choose a committed target without the invalid repository path, then retry.",
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
    return sourcePhaseFailure(phase, mode);
  }
  return sourcePhaseFailure(phase, mode);
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
  const requestedBase = safeRequestedBase(options.baseRef);
  let source: ScanSourceIdentity =
    options.baseRef === undefined
      ? { mode: "index", baseline: null, target: "index" }
      : {
          mode: "base",
          baseline: null,
          target: null,
          ...(requestedBase === undefined ? {} : { requestedBase }),
        };
  let changedFileCount: number | null = null;
  const networkDisclosures: NetworkDisclosure[] = [];
  let activePhase: ActiveScanPhase = "configuration";
  let report: ScanReport | undefined;
  let abortedError: unknown;
  let shouldRethrow = false;
  let includeSourceExcerpts = false;
  let presentationPolicy: ScanPresentationPolicy = Object.freeze({
    terminalFindingLimit: 25,
    temporaryReportMaxAge: "24h",
    persistSourceExcerpts: false,
    agentGuidance: EMPTY_AGENT_GUIDANCE,
  });

  const reportContext = (): ScanReportContext => ({
    repositoryRoot: options.repositoryRoot,
    source,
    changedFileCount,
    startedAt,
    durationMs: Math.max(0, dependencies.clock() - started),
    networkDisclosures,
    presentationPolicy,
  });

  try {
    const bootstrapResourcePolicy = resolveScanResourcePolicy(
      { gitHardTimeout: "30s" },
      {
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.noTimeout ? { noTimeout: true } : {}),
      },
    );
    const bootstrapGit = dependencies.createGitClient(options.repositoryRoot, {
      resourcePolicy: bootstrapResourcePolicy,
    });
    let config: ResolvedConfig;
    let baseComparison:
      | Awaited<ReturnType<RunScanDependencies["resolveBaseComparison"]>>
      | undefined;
    if (options.baseRef === undefined) {
      activePhase = "configuration";
      config = await dependencies.loadIndexConfig(
        options.repositoryRoot,
        bootstrapGit,
        options.configPath,
        options.signal,
      );
    } else {
      activePhase = "baseline-resolution";
      baseComparison = await dependencies.resolveBaseComparison(
        bootstrapGit,
        options.baseRef,
        options.signal,
      );
      source = sanitizeScanSourceIdentity({
        mode: "base",
        baseline: baseComparison.baselineCommit,
        target: baseComparison.targetCommit,
        requestedBase: baseComparison.requestedBase,
      });
      activePhase = "configuration";
      config = await dependencies.loadCommitConfig(
        options.repositoryRoot,
        bootstrapGit,
        baseComparison.targetCommit,
        options.configPath,
        options.signal,
      );
    }
    const resourcePolicy = resolveScanResourcePolicy(config.resources, {
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.noTimeout ? { noTimeout: true } : {}),
    });
    includeSourceExcerpts = shouldIncludeSourceExcerpts(
      config.reporting.sourceExcerpts,
      options.reportingSurface,
      options.sourceExcerpts,
    );
    presentationPolicy = Object.freeze({
      terminalFindingLimit: config.reporting.terminalFindingLimit,
      temporaryReportMaxAge: config.reporting.temporaryReportMaxAge,
      persistSourceExcerpts: shouldPersistSourceExcerpts(
        config.reporting.sourceExcerpts,
        options.sourceExcerpts,
      ),
      agentGuidance: config.reporting.agentGuidance,
    });
    activePhase = "change-discovery";
    const git = dependencies.createGitClient(options.repositoryRoot, {
      resourcePolicy,
      onSoftTimeout: () =>
        options.onEvent?.({
          type: "git-soft-timeout",
          checkId: "zedbee",
          target: ".",
          timestamp: dependencies.clock(),
        }),
    });
    const splitChangeDiscovery =
      baseComparison === undefined
        ? dependencies.discoverIndexChangeSet !== undefined &&
          dependencies.addIndexLineRanges !== undefined
        : dependencies.discoverCommitChangeSet !== undefined &&
          dependencies.addCommitLineRanges !== undefined;
    let changeSet =
      splitChangeDiscovery && baseComparison === undefined
        ? await dependencies.discoverIndexChangeSet!(git, options.signal)
        : splitChangeDiscovery
          ? await dependencies.discoverCommitChangeSet!(
              git,
              baseComparison!.baselineCommit,
              baseComparison!.targetCommit,
              options.signal,
            )
          : baseComparison === undefined
            ? await dependencies.readIndexChangeSet(git, options.signal)
            : await dependencies.readCommitChangeSet(
                git,
                baseComparison.baselineCommit,
                baseComparison.targetCommit,
                options.signal,
              );
    const policyForFile = createFilePolicyResolver(config, changeSet);
    changedFileCount = changeSet.files.size;

    if (changeSet.isEmpty) {
      if (baseComparison === undefined) {
        activePhase = "baseline-resolution";
        source = {
          mode: "index",
          baseline: await dependencies.baselineForEmptyChange(
            git,
            options.signal,
          ),
          target: "index",
        };
      }
      report = {
        schemaVersion: 1,
        outcome: "pass",
        exitCode: 0,
        repositoryRoot: options.repositoryRoot,
        ...source,
        changedFileCount,
        startedAt,
        durationMs: Math.max(0, dependencies.clock() - started),
        networkDisclosures,
        presentationPolicy,
        summary: summarizeChecks([]),
        checks: [],
      };
    } else {
      activePhase = "snapshot-construction";
      snapshots =
        baseComparison === undefined
          ? await dependencies.buildIndexSnapshots(
              options.repositoryRoot,
              git,
              options.signal,
            )
          : await dependencies.buildCommitSnapshots(
              options.repositoryRoot,
              git,
              baseComparison.baselineCommit,
              baseComparison.targetCommit,
              options.signal,
            );
      if (baseComparison === undefined) {
        source = {
          mode: "index",
          baseline: snapshots.baselineRef,
          target: snapshots.targetRef,
        };
      }
      const unsupportedFailures = unsupportedEntryFailures(
        snapshots.unsupportedEntries,
        new Set(changeSet.files.keys()),
        policyForFile,
        source.mode,
      );
      if (unsupportedFailures.length > 0) {
        report = createIncompleteReport(reportContext(), unsupportedFailures);
      } else {
        if (splitChangeDiscovery) {
          activePhase = "change-discovery";
          const excludedPaths = new Set(
            snapshots.unsupportedEntries.map((entry) => entry.path),
          );
          for (const path of snapshots.symlinkPaths ?? []) {
            excludedPaths.add(path);
          }
          const baselineUnsupportedPaths = new Set(
            (snapshots.baselineUnsupportedEntries ?? []).map(
              (entry) => entry.path,
            ),
          );
          for (const path of snapshots.baselineSymlinkPaths ?? []) {
            baselineUnsupportedPaths.add(path);
          }
          const wholeFilePaths = [...changeSet.files.values()]
            .filter((file) => {
              const baselinePath = file.previousPath ?? file.path;
              return (
                file.status !== "deleted" &&
                !excludedPaths.has(file.path) &&
                baselineUnsupportedPaths.has(baselinePath)
              );
            })
            .map((file) => file.path);
          for (const path of wholeFilePaths) excludedPaths.add(path);
          changeSet =
            baseComparison === undefined
              ? await dependencies.addIndexLineRanges!(
                  git,
                  changeSet,
                  excludedPaths,
                  options.signal,
                )
              : await dependencies.addCommitLineRanges!(
                  git,
                  changeSet,
                  excludedPaths,
                  baseComparison.baselineCommit,
                  baseComparison.targetCommit,
                  options.signal,
                );
          if (wholeFilePaths.length > 0) {
            const lineCounts = new Map<string, number>();
            for (const path of wholeFilePaths) {
              const count = await countSnapshotFileLines(
                snapshots.targetDir,
                path,
                options.signal,
              );
              if (count !== undefined) lineCounts.set(path, count);
            }
            changeSet = addWholeFileLineRanges(changeSet, lineCounts);
          }
        }
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
            policyForFile,
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
        const reportedResults = includeSourceExcerpts
          ? await enrichSourceExcerpts(decision.results, targetInspection)
          : omitSourceExcerpts(decision.results);
        report = {
          schemaVersion: 1,
          outcome: decision.outcome,
          exitCode: decision.exitCode,
          repositoryRoot: options.repositoryRoot,
          ...source,
          changedFileCount,
          startedAt,
          durationMs: Math.max(0, dependencies.clock() - started),
          networkDisclosures,
          presentationPolicy,
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
          source.mode,
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
