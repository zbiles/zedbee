import { dirname } from "node:path";
import {
  createLocalAnalyzerExecutor,
  type AnalyzerExecutor,
  type AnalyzerExecutionSession,
} from "../checks/runner/executor.js";
import { withAnalyzerExecutionSession } from "../checks/runner/session.js";
import type { CheckAdapter, CheckExecutionResult } from "../checks/adapter.js";
import { DEFAULT_CHECK_ADAPTERS } from "../checks/descriptors.js";
import { dispatchChecks, type DispatchOptions } from "../checks/dispatcher.js";
import type { ScanEvent } from "../checks/events.js";
import {
  loadConfigFromCommit,
  loadConfigFromIndex,
} from "../config/load-config.js";
import {
  createFilePolicyResolver,
  type FilePolicyResolver,
} from "../config/file-policy.js";
import type { ResolvedConfig, PathExclusion } from "../config/schema.js";
import {
  addCommitLineRanges,
  addStagedLineRanges,
  addWholeFileLineRanges,
  discoverCommitChangeSet,
  discoverStagedChangeSet,
  type ChangeSet,
  readCommitChangeSet,
  readStagedChangeSet,
} from "../git/change-set.js";
import { resolveBaseComparison } from "../git/base-comparison.js";
import { safeRequestedBase } from "../git/base-ref.js";
import { GitClient } from "../git/client.js";
import {
  buildCommitSnapshotPair,
  buildSnapshotPair,
  countSnapshotFileLines,
  SnapshotConstructionCleanupError,
  type SnapshotPair,
} from "../git/snapshot.js";
import {
  validateReportableSnapshotPath,
  type ValidatedSnapshotPath,
} from "../git/snapshot-path.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import type { RepositoryInspection } from "../inspection/types.js";
import { resolveScanResourcePolicy } from "./resource-policy.js";
import {
  sanitizeScanSourceIdentity,
  type ScanSourceIdentity,
} from "./source-mode.js";
import type { ActiveScanPhase } from "./analysis-failure.js";
import type { ScanFailureInput } from "./incomplete-report.js";
import { unsupportedEntryFailures } from "./unsupported-inputs.js";

export interface AnalysisSessionDependencies {
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
  adapters: readonly CheckAdapter[];
  clock(): number;
}

export const DEFAULT_ANALYSIS_SESSION_DEPENDENCIES: AnalysisSessionDependencies =
  {
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
    adapters: DEFAULT_CHECK_ADAPTERS,
    clock: () => performance.now(),
  };

function appliedPathExclusionsForConfig(
  changeSet: ChangeSet,
  policyForFile: FilePolicyResolver,
): readonly PathExclusion[] {
  const seen = new Set<string>();
  const matches: PathExclusion[] = [];
  if (policyForFile.pathExclusionsForPath === undefined) {
    return matches;
  }

  for (const file of changeSet.files.values()) {
    const pathsToCheck: [string, "target" | "baseline"][] = [
      [file.path, "target"],
      ...(file.previousPath === undefined || file.status !== "renamed"
        ? []
        : [[file.previousPath, "baseline"] as [string, "baseline"]]),
    ];
    for (const [path, side] of pathsToCheck) {
      for (const exclusion of policyForFile.pathExclusionsForPath(path, side)) {
        const signature = JSON.stringify(exclusion);
        if (seen.has(signature)) continue;
        seen.add(signature);
        matches.push(exclusion);
      }
    }
  }

  return Object.freeze(matches);
}

export interface AnalysisSessionState {
  phase: ActiveScanPhase;
  source: ScanSourceIdentity;
  changedFileCount: number | null;
  configuredPathExclusions: readonly PathExclusion[];
  appliedPathExclusions: readonly PathExclusion[];
}
interface PreparedSource {
  readonly config: ResolvedConfig;
  readonly git: GitClient;
  readonly signal: AbortSignal;
  readonly changeSet: ChangeSet;
}
export type AnalysisSession =
  | (PreparedSource & { readonly kind: "empty" })
  | (PreparedSource & {
      readonly kind: "unsupported";
      readonly failures: readonly ScanFailureInput[];
    })
  | (PreparedSource & {
      readonly kind: "analyzed";
      readonly executions: readonly CheckExecutionResult[];
      readonly targetInspection: RepositoryInspection;
    });

export interface AnalysisSessionOptions {
  executor?: AnalyzerExecutor;
  repositoryRoot: string;
  baseRef?: string;
  configPath?: string;
  timeout?: string;
  noTimeout?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: ScanEvent) => void;
  onConfiguration?: (config: ResolvedConfig) => void;
  /** Fix previews have no public baseline and preserve their empty-index fast path. */
  resolveEmptyBaseline?: boolean;
  dependencies?: AnalysisSessionDependencies;
  dispatchOptions?: () => DispatchOptions;
}
export interface AnalysisCleanupFailure {
  readonly temporaryPath?: ValidatedSnapshotPath;
}
export type AnalysisSessionOutcome<T> = {
  readonly state: AnalysisSessionState;
  readonly cleanupFailure?: AnalysisCleanupFailure;
} & (
  | { readonly completed: true; readonly value: T }
  | { readonly completed: false; readonly error: unknown }
);

function safeCleanupFailure(path: string | undefined): AnalysisCleanupFailure {
  try {
    return { temporaryPath: validateReportableSnapshotPath(path ?? "") };
  } catch {
    return {};
  }
}

/** A fresh, callback-scoped analysis. Workers settle before this owner removes snapshots. */
export async function withAnalysisSession<T>(
  options: AnalysisSessionOptions,
  consume: (
    session: AnalysisSession,
    state: AnalysisSessionState,
  ) => Promise<T>,
): Promise<AnalysisSessionOutcome<T>> {
  const dependencies =
    options.dependencies ?? DEFAULT_ANALYSIS_SESSION_DEPENDENCIES;
  const signal = options.signal ?? new AbortController().signal;
  const requestedBase = safeRequestedBase(options.baseRef);
  const state: AnalysisSessionState = {
    phase: "configuration",
    source:
      options.baseRef === undefined
        ? { mode: "index", baseline: null, target: "index" }
        : {
            mode: "base",
            baseline: null,
            target: null,
            ...(requestedBase === undefined ? {} : { requestedBase }),
          },
    changedFileCount: null,
    configuredPathExclusions: [],
    appliedPathExclusions: [],
  };
  let snapshots: SnapshotPair | undefined;
  let executor: AnalyzerExecutor | undefined;
  let execution: AnalyzerExecutionSession | undefined;
  let executionCleanupProved = true;
  let cleanupFailure: AnalysisCleanupFailure | undefined;
  let completion:
    { completed: true; value: T } | { completed: false; error: unknown };
  try {
    signal.throwIfAborted();
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
    let baseComparison:
      Awaited<ReturnType<typeof resolveBaseComparison>> | undefined;
    let config: ResolvedConfig;
    if (options.baseRef === undefined) {
      config = await dependencies.loadIndexConfig(
        options.repositoryRoot,
        bootstrapGit,
        options.configPath,
        options.signal,
      );
    } else {
      state.phase = "baseline-resolution";
      baseComparison = await dependencies.resolveBaseComparison(
        bootstrapGit,
        options.baseRef,
        options.signal,
      );
      state.source = sanitizeScanSourceIdentity({
        mode: "base",
        baseline: baseComparison.baselineCommit,
        target: baseComparison.targetCommit,
        requestedBase: baseComparison.requestedBase,
      });
      state.phase = "configuration";
      config = await dependencies.loadCommitConfig(
        options.repositoryRoot,
        bootstrapGit,
        baseComparison.targetCommit,
        options.configPath,
        options.signal,
      );
    }
    state.configuredPathExclusions = config.pathExclusions;
    const resourcePolicy = resolveScanResourcePolicy(config.resources, {
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.noTimeout ? { noTimeout: true } : {}),
    });
    options.onConfiguration?.(config);
    signal.throwIfAborted();
    state.phase = "change-discovery";
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
    state.appliedPathExclusions = appliedPathExclusionsForConfig(
      changeSet,
      policyForFile,
    );
    state.changedFileCount = changeSet.files.size;
    signal.throwIfAborted();
    let session: AnalysisSession;
    if (changeSet.isEmpty) {
      if (
        baseComparison === undefined &&
        options.resolveEmptyBaseline !== false
      ) {
        state.phase = "baseline-resolution";
        state.source = {
          mode: "index",
          baseline: await dependencies.baselineForEmptyChange(
            git,
            options.signal,
          ),
          target: "index",
        };
      }
      session = { kind: "empty", config, git, signal, changeSet };
    } else {
      state.phase = "snapshot-construction";
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
        state.source = {
          mode: "index",
          baseline: snapshots.baselineRef,
          target: snapshots.targetRef,
        };
      }
      signal.throwIfAborted();
      const failures = unsupportedEntryFailures(
        snapshots.unsupportedEntries,
        new Set(changeSet.files.keys()),
        policyForFile,
        state.source.mode,
      );
      if (failures.length > 0) {
        session = {
          kind: "unsupported",
          config,
          git,
          signal,
          changeSet,
          failures,
        };
      } else {
        if (splitChangeDiscovery) {
          state.phase = "change-discovery";
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

        signal.throwIfAborted();
        state.phase = "baseline-inspection";
        const baselineInspection = await dependencies.inspectRepository(
          snapshots.baselineDir,
        );
        signal.throwIfAborted();
        state.phase = "target-inspection";
        const targetInspection = await dependencies.inspectRepository(
          snapshots.targetDir,
        );
        signal.throwIfAborted();
        state.phase = "dispatch";
        executor = options.executor ?? createLocalAnalyzerExecutor();
        executionCleanupProved = false;
        execution = await executor.openSession({
          sourceSelections: [baselineInspection, targetInspection].map(
            (inspection) => ({
              snapshotRoot: inspection.snapshotRoot,
              paths: [
                ...new Set(
                  inspection.workspaces.flatMap(
                    (workspace) => workspace.sourceFiles,
                  ),
                ),
              ],
            }),
          ),
        });
        const executions = await withAnalyzerExecutionSession(execution, () =>
          dependencies.dispatch(
            dependencies.adapters,
            {
              repositoryRoot: options.repositoryRoot,
              changeSet,
              config,
              snapshots: snapshots!,
              baselineInspection,
              targetInspection,
              signal,
              policyForFile,
            },
            options.dispatchOptions?.(),
          ),
        );
        signal.throwIfAborted();
        session = {
          kind: "analyzed",
          config,
          git,
          signal,
          changeSet,
          executions,
          targetInspection,
        };
      }
    }
    if (session.kind === "analyzed") state.phase = "policy-evaluation";
    completion = {
      completed: true,
      value: await (execution === undefined
        ? consume(session, state)
        : withAnalyzerExecutionSession(execution, () =>
            consume(session, state),
          )),
    };
  } catch (error) {
    if (error instanceof SnapshotConstructionCleanupError) {
      cleanupFailure = safeCleanupFailure(error.temporaryPath);
      completion = { completed: false, error: error.constructionError };
    } else {
      completion = { completed: false, error };
    }
  }
  try {
    if (execution !== undefined) {
      await execution.close();
      executionCleanupProved = true;
    }
  } catch {
    executionCleanupProved = false;
  }
  if (executor !== undefined && options.executor === undefined) {
    try {
      await executor.close();
      // Local executor close also proves cleanup after a failed open.
      if (execution === undefined) executionCleanupProved = true;
    } catch {
      executionCleanupProved = false;
    }
  }
  try {
    if (!executionCleanupProved) throw new Error("Unproved execution cleanup");
    await snapshots?.cleanup();
  } catch {
    cleanupFailure = safeCleanupFailure(
      snapshots === undefined ? undefined : dirname(snapshots.targetDir),
    );
  }
  if (completion.completed && signal.aborted) {
    completion = { completed: false, error: signal.reason };
  }
  return {
    ...completion,
    state,
    ...(cleanupFailure === undefined ? {} : { cleanupFailure }),
  };
}
