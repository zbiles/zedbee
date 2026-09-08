import type { CheckExecutionResult } from "../checks/adapter.js";
import type { AnalyzerExecutor } from "../checks/runner/executor.js";
export { DEFAULT_CHECK_ADAPTERS } from "../checks/descriptors.js";
import type { DispatchOptions } from "../checks/dispatcher.js";
import type { ScanEvent } from "../checks/events.js";
import type { ResolvedConfig } from "../config/schema.js";
import { EMPTY_AGENT_GUIDANCE } from "../reporting/agent-guidance.js";
import { summarizeChecks } from "../core/summarize.js";
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
import {
  defaultObservationCacheRoot,
  ObservationCacheStore,
  type ObservationCache,
} from "../cache/store.js";
import {
  withAnalysisSession,
  DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
  type AnalysisSessionDependencies,
  type AnalysisSessionState,
} from "./analysis-session.js";
import {
  phaseFailure,
  AnalysisSessionCleanupError,
  retainCleanupFailure,
} from "./analysis-failure.js";

export interface RunScanDependencies extends AnalysisSessionDependencies {
  evaluate(
    results: readonly CheckExecutionResult[],
    config: ResolvedConfig,
  ): PolicyDecision;
  now(): Date;
  createObservationCache?(): ObservationCache;
}

export interface RunScanOptions {
  /** Experimental: each scan owns a fresh session, never the supplied executor. */
  executor?: AnalyzerExecutor;
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

const DEFAULT_DEPENDENCIES: RunScanDependencies = {
  ...DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
  evaluate: evaluatePolicy,
  now: () => new Date(),
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
  const networkDisclosures: NetworkDisclosure[] = [];
  let includeSourceExcerpts = false;
  let presentationPolicy: ScanPresentationPolicy = Object.freeze({
    terminalFindingLimit: 25,
    temporaryReportMaxAge: "24h",
    persistSourceExcerpts: false,
    agentGuidance: EMPTY_AGENT_GUIDANCE,
  });
  const reportContext = (state: AnalysisSessionState): ScanReportContext => ({
    repositoryRoot: options.repositoryRoot,
    source: state.source,
    changedFileCount: state.changedFileCount,
    startedAt,
    durationMs: Math.max(0, dependencies.clock() - started),
    configuredPathExclusions: state.configuredPathExclusions,
    appliedPathExclusions: state.appliedPathExclusions,
    networkDisclosures,
    presentationPolicy,
  });
  const outcome = await withAnalysisSession(
    {
      ...options,
      dependencies,
      onConfiguration(config) {
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
      },
      dispatchOptions: () =>
        dispatchOptions(
          options.onEvent,
          networkDisclosures,
          options.cache === false
            ? undefined
            : (options.cache ?? dependencies.createObservationCache?.()),
        ),
    },
    async (session, state): Promise<ScanReport> => {
      if (session.kind === "unsupported")
        return createIncompleteReport(reportContext(state), session.failures);
      const decision =
        session.kind === "empty"
          ? undefined
          : dependencies.evaluate(session.executions, session.config);
      const checks =
        decision === undefined
          ? []
          : includeSourceExcerpts && session.kind === "analyzed"
            ? await enrichSourceExcerpts(
                decision.results,
                session.targetInspection,
              )
            : omitSourceExcerpts(decision.results);
      const context = reportContext(state);
      return {
        schemaVersion: 1,
        outcome: decision?.outcome ?? "pass",
        exitCode: decision?.exitCode ?? 0,
        repositoryRoot: options.repositoryRoot,
        ...state.source,
        changedFileCount: state.changedFileCount,
        startedAt,
        durationMs: context.durationMs,
        configuredPathExclusions: context.configuredPathExclusions,
        appliedPathExclusions: context.appliedPathExclusions,
        networkDisclosures,
        presentationPolicy,
        summary: summarizeChecks(checks),
        checks,
      };
    },
  );
  if (!outcome.completed && options.signal?.aborted === true) {
    if (outcome.cleanupFailure !== undefined) {
      throw retainCleanupFailure(
        outcome.error,
        new AnalysisSessionCleanupError(outcome.cleanupFailure.temporaryPath, {
          cause: outcome.error,
          primaryFailure: phaseFailure(
            outcome.error,
            outcome.state.phase,
            outcome.state.source.mode,
          ),
        }),
      );
    }
    throw outcome.error;
  }
  let report = outcome.completed
    ? outcome.value
    : createIncompleteReport(
        reportContext(outcome.state),
        phaseFailure(
          outcome.error,
          outcome.state.phase,
          outcome.state.source.mode,
        ),
      );
  if (outcome.cleanupFailure !== undefined) {
    const durationMs = Math.max(0, dependencies.clock() - started);
    report =
      outcome.cleanupFailure.temporaryPath === undefined
        ? withUnreportableCleanupFailure(report, durationMs)
        : withCleanupFailure(
            report,
            outcome.cleanupFailure.temporaryPath,
            durationMs,
          );
  }
  return deepFreeze(report);
}
