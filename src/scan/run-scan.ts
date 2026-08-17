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
import { loadConfig } from "../config/load-config.js";
import type { ResolvedConfig } from "../config/schema.js";
import { summarizeChecks } from "../core/summarize.js";
import type { CheckResult } from "../core/types.js";
import { readStagedChangeSet, type ChangeSet } from "../git/change-set.js";
import { GitClient } from "../git/client.js";
import { buildSnapshotPair, type SnapshotPair } from "../git/snapshot.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import type { RepositoryInspection } from "../inspection/types.js";
import { evaluatePolicy, type PolicyDecision } from "../policy/evaluate.js";
import type { NetworkDisclosure, ScanReport } from "./report.js";
import type {
  ReportingSurface,
  SourceExcerptOverride,
} from "./reporting-options.js";
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

function incompleteReport(
  repositoryRoot: string,
  baseline: "HEAD" | null,
  stagedFileCount: number | null,
  startedAt: string,
  durationMs: number,
  networkDisclosures: readonly NetworkDisclosure[],
): ScanReport {
  const result: CheckResult = {
    checkId: "zedbee",
    status: "incomplete",
    durationMs,
    findings: [],
    error: {
      code: "SCAN_FAILED",
      message: "Zedbee could not complete the scan",
    },
  };
  return deepFreeze({
    schemaVersion: 1,
    outcome: "incomplete",
    exitCode: 2,
    repositoryRoot,
    baseline,
    target: "index",
    stagedFileCount,
    startedAt,
    durationMs,
    networkDisclosures,
    summary: summarizeChecks([result]),
    checks: [result],
  });
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

  try {
    const config = await dependencies.loadConfig(
      options.repositoryRoot,
      options.configPath,
    );
    const git = dependencies.createGitClient(options.repositoryRoot);
    const changeSet = await dependencies.readChangeSet(git);
    stagedFileCount = changeSet.files.size;

    if (changeSet.isEmpty) {
      baseline = await dependencies.baselineForEmptyChange(git);
      return deepFreeze({
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
      });
    }

    snapshots = await dependencies.buildSnapshots(options.repositoryRoot, git);
    baseline = snapshots.baselineRef;
    if (
      snapshots.unsupportedEntries.some(
        ({ kind }) => kind === "git-lfs-pointer",
      )
    ) {
      return incompleteReport(
        options.repositoryRoot,
        baseline,
        stagedFileCount,
        startedAt,
        Math.max(0, dependencies.clock() - started),
        networkDisclosures,
      );
    }
    const baselineInspection = await dependencies.inspectRepository(
      snapshots.baselineDir,
    );
    const targetInspection = await dependencies.inspectRepository(
      snapshots.targetDir,
    );
    const controller =
      options.signal === undefined ? new AbortController() : undefined;
    const signal = options.signal ?? controller!.signal;
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
    const decision = dependencies.evaluate(results, config);
    return deepFreeze({
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
      summary: decision.summary,
      checks: decision.results,
    });
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw error;
    }
    return incompleteReport(
      options.repositoryRoot,
      baseline,
      stagedFileCount,
      startedAt,
      Math.max(0, dependencies.clock() - started),
      networkDisclosures,
    );
  } finally {
    try {
      await snapshots?.cleanup();
    } catch {
      if (options.signal?.aborted !== true) {
        return incompleteReport(
          options.repositoryRoot,
          baseline,
          stagedFileCount,
          startedAt,
          Math.max(0, dependencies.clock() - started),
          networkDisclosures,
        );
      }
    }
  }
}
