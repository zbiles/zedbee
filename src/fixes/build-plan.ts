import { planCandidates } from "./plan-candidates.js";
import {
  workingFilePreviews,
  changedWorkingFiles,
  type WorkingPreviewDependencies,
} from "./working-preview.js";
import { publicPlan, planChecks } from "./public-plan.js";
import { addFormattingForExactCandidates } from "./prettier-provider.js";
export { renderFixPlanJson } from "./public-plan.js";
import { freezeResult } from "../core/freeze-result.js";
import { readonlyMap } from "../core/immutable-map.js";
import type { AnalyzerExecutor } from "../checks/runner/executor.js";
import type { CheckAdapter, CheckExecutionResult } from "../checks/adapter.js";
import { dispatchChecks } from "../checks/dispatcher.js";
import { loadConfigFromIndex } from "../config/load-config.js";
import type { ResolvedConfig } from "../config/schema.js";
import type { ChangeSet } from "../git/change-set.js";
import { readStagedChangeSet } from "../git/change-set.js";
import { GitClient } from "../git/client.js";
import { buildSnapshotPair, type SnapshotPair } from "../git/snapshot.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import type { RepositoryInspection } from "../inspection/types.js";
import { evaluatePolicy, type PolicyDecision } from "../policy/evaluate.js";
import { parseTemporaryReportMaxAge } from "../reporting/report-age.js";
import { DEFAULT_CHECK_ADAPTERS } from "../checks/descriptors.js";
import {
  withAnalysisSession,
  DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
  type AnalysisSessionDependencies,
} from "../scan/analysis-session.js";
import {
  AnalysisSessionCleanupError,
  phaseFailure,
} from "../scan/analysis-failure.js";
import {
  FIXABLE_CHECK_IDS,
  type CheckFixCandidate,
  type FixableCheckId,
  type PreparedFixPlan,
} from "./types.js";

export interface BuildFixPlanDependencies extends WorkingPreviewDependencies {
  captureIndexComparison?: AnalysisSessionDependencies["captureIndexComparison"];
  loadConfig(
    repositoryRoot: string,
    git: GitClient,
    configPath?: string,
    signal?: AbortSignal,
  ): Promise<ResolvedConfig>;
  createGitClient(
    repositoryRoot: string,
    options?: ConstructorParameters<typeof GitClient>[1],
  ): GitClient;
  readChangeSet(git: GitClient, signal?: AbortSignal): Promise<ChangeSet>;
  discoverChangeSet?: AnalysisSessionDependencies["discoverIndexChangeSet"];
  addLineRanges?: AnalysisSessionDependencies["addIndexLineRanges"];
  buildSnapshots(
    repositoryRoot: string,
    git: GitClient,
    signal?: AbortSignal,
  ): Promise<SnapshotPair>;
  inspectRepository(snapshotRoot: string): Promise<RepositoryInspection>;
  dispatch: typeof dispatchChecks;
  evaluate(
    results: readonly CheckExecutionResult[],
    config: ResolvedConfig,
  ): PolicyDecision;
  adapters: readonly CheckAdapter[];
}

export interface BuildFixPlanOptions {
  readonly executor?: AnalyzerExecutor;
  readonly repositoryRoot: string;
  readonly configPath?: string;
  readonly selectedChecks?: readonly FixableCheckId[];
  readonly signal?: AbortSignal;
  /** Invocation-only consent for project Prettier execution. */
  readonly projectPrettierTrust?: boolean;
  readonly dependencies?: BuildFixPlanDependencies;
}

export class FixPlanCleanupError extends AnalysisSessionCleanupError {
  constructor(
    ...args: ConstructorParameters<typeof AnalysisSessionCleanupError>
  ) {
    super(...args);
    this.name = "FixPlanCleanupError";
  }
}

const DEFAULT_DEPENDENCIES: BuildFixPlanDependencies = {
  captureIndexComparison:
    DEFAULT_ANALYSIS_SESSION_DEPENDENCIES.captureIndexComparison,
  loadConfig: loadConfigFromIndex,
  createGitClient: (repositoryRoot, options) =>
    new GitClient(repositoryRoot, options),
  readChangeSet: readStagedChangeSet,
  discoverChangeSet:
    DEFAULT_ANALYSIS_SESSION_DEPENDENCIES.discoverIndexChangeSet,
  addLineRanges: DEFAULT_ANALYSIS_SESSION_DEPENDENCIES.addIndexLineRanges,
  buildSnapshots: buildSnapshotPair,
  inspectRepository,
  dispatch: dispatchChecks,
  evaluate: evaluatePolicy,
  adapters: DEFAULT_CHECK_ADAPTERS,
  changedWorkingFiles,
};

function selectedChecks(
  input: readonly FixableCheckId[] | undefined,
): readonly FixableCheckId[] {
  const selected = input === undefined ? FIXABLE_CHECK_IDS : input;
  if (!selected.every((checkId) => FIXABLE_CHECK_IDS.includes(checkId))) {
    throw new TypeError("Expected a supported managed fix check selector.");
  }
  return Object.freeze([...new Set(selected)]);
}

function selectedAdapters(
  adapters: readonly CheckAdapter[],
  selected: ReadonlySet<FixableCheckId>,
): readonly CheckAdapter[] {
  return Object.freeze(
    adapters.filter(
      (adapter) =>
        FIXABLE_CHECK_IDS.includes(adapter.id as FixableCheckId) &&
        selected.has(adapter.id as FixableCheckId),
    ),
  );
}

function collectCandidates(
  executions: readonly CheckExecutionResult[],
  selected: ReadonlySet<FixableCheckId>,
): readonly CheckFixCandidate[] {
  const incompleteChecks = new Set(
    executions
      .filter((execution) => execution.result.status === "incomplete")
      .map((execution) => execution.result.checkId),
  );
  const candidates = executions.flatMap((execution) =>
    execution.result.status === "completed"
      ? (execution.fixCandidates ?? [])
      : [],
  );
  const filtered = candidates.filter(
    (candidate) =>
      selected.has(candidate.checkId) &&
      !incompleteChecks.has(candidate.checkId),
  );
  return Object.freeze(
    addFormattingForExactCandidates(filtered, selected, executions).filter(
      (candidate) => !incompleteChecks.has(candidate.checkId),
    ),
  );
}

function unsupportedInputError(): Error {
  return new Error(
    "Zedbee cannot build a fix plan for unsupported staged input.",
  );
}

/** Map the existing experimental injection surface once at the session boundary. */
function sessionDependencies(
  dependencies: BuildFixPlanDependencies,
  selected: ReadonlySet<FixableCheckId>,
): AnalysisSessionDependencies {
  const {
    captureIndexComparison: _capture,
    discoverIndexChangeSet: _discover,
    addIndexLineRanges: _ranges,
    ...shared
  } = DEFAULT_ANALYSIS_SESSION_DEPENDENCIES;
  return {
    ...shared,
    ...(dependencies.captureIndexComparison === undefined
      ? {}
      : { captureIndexComparison: dependencies.captureIndexComparison }),
    createGitClient: dependencies.createGitClient,
    loadIndexConfig: dependencies.loadConfig,
    readIndexChangeSet: dependencies.readChangeSet,
    ...(dependencies.discoverChangeSet === undefined
      ? {}
      : { discoverIndexChangeSet: dependencies.discoverChangeSet }),
    ...(dependencies.addLineRanges === undefined
      ? {}
      : { addIndexLineRanges: dependencies.addLineRanges }),
    buildIndexSnapshots: dependencies.buildSnapshots,
    inspectRepository: dependencies.inspectRepository,
    dispatch: dependencies.dispatch,
    adapters: selectedAdapters(dependencies.adapters, selected),
  };
}

export async function buildFixPlan(
  options: BuildFixPlanOptions,
): Promise<PreparedFixPlan> {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const selected = selectedChecks(options.selectedChecks);
  const selectedSet = new Set(selected);
  const outcome = await withAnalysisSession(
    {
      repositoryRoot: options.repositoryRoot,
      ...(options.executor === undefined ? {} : { executor: options.executor }),
      ...(options.configPath === undefined
        ? {}
        : { configPath: options.configPath }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.projectPrettierTrust === true
        ? { projectPrettierTrust: true }
        : {}),
      dependencies: sessionDependencies(dependencies, selectedSet),
      resolveEmptyBaseline: false,
      dispatchOptions: () => ({ collectFixes: true }),
    },
    async (session): Promise<PreparedFixPlan> => {
      const { config, git, signal } = session;
      if (session.kind === "unsupported") throw unsupportedInputError();
      if (session.kind === "empty") {
        return freezeResult({
          publicPlan: publicPlan(
            selected,
            [],
            readonlyMap([]),
            planChecks(selected, [], []),
          ),
          repositoryRoot: options.repositoryRoot,
          candidates: Object.freeze([]),
          workingFiles: readonlyMap([]),
          temporaryReportMaxAgeMs: parseTemporaryReportMaxAge(
            config.reporting.temporaryReportMaxAge,
          ),
        });
      }
      const { executions } = session;
      const decision = dependencies.evaluate(executions, config);
      signal.throwIfAborted();
      const candidates = collectCandidates(executions, selectedSet);
      const workingFiles = await workingFilePreviews(
        options.repositoryRoot,
        candidates,
        git,
        signal,
        dependencies,
      );
      const planned = planCandidates(candidates, workingFiles);
      const checks = planChecks(selected, executions, planned.items);
      return freezeResult({
        publicPlan: publicPlan(
          selected,
          planned.items,
          workingFiles,
          checks,
          decision,
        ),
        repositoryRoot: options.repositoryRoot,
        candidates: planned.candidates,
        workingFiles,
        temporaryReportMaxAgeMs: parseTemporaryReportMaxAge(
          config.reporting.temporaryReportMaxAge,
        ),
      });
    },
  );
  if (outcome.cleanupFailure !== undefined) {
    throw new FixPlanCleanupError(
      outcome.cleanupFailure.temporaryPath,
      outcome.completed
        ? undefined
        : {
            cause: outcome.error,
            primaryFailure: phaseFailure(
              outcome.error,
              outcome.state.phase,
              outcome.state.source.mode,
            ),
          },
    );
  }
  if (!outcome.completed) throw outcome.error;
  return outcome.value;
}
