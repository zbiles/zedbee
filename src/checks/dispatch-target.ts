import { recordPerformance } from "../diagnostics/scan-performance.js";
import type { ResolvedCheckPolicy } from "../config/schema.js";
import type { FilePolicyResolver } from "../config/file-policy.js";
import type { CheckResult } from "../core/types.js";
import type { CheckFixCandidate } from "../fixes/types.js";
import { checkLabel } from "../core/check-label.js";
import { displayResultForPolicy } from "../policy/evaluate.js";
import { sanitizeFixCandidates } from "../fixes/sanitize.js";
import type {
  CheckExecutionResult,
  CheckRunContext,
  CheckTarget,
} from "./adapter.js";
import { observationCheckResult } from "./observation-result.js";
import { sanitizeCheckResult } from "./sanitize-result.js";
import { incompleteResult } from "./incomplete-result.js";
import { CheckIncompleteError } from "./incomplete-error.js";
import { AnalyzerJobError } from "./diagnostics.js";
import { scopedContext, type DispatchContext } from "./dispatch-context.js";
import type { AdapterSnapshot } from "./dispatch-adapter.js";
import type { createDispatchObservationCollector } from "./dispatch-cache.js";
import type { ScanEvent } from "./events.js";

export function executionResult(
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

export async function executeDispatchTarget(
  adapter: AdapterSnapshot,
  adapterContext: DispatchContext,
  target: CheckTarget,
  executionPolicy: Readonly<ResolvedCheckPolicy>,
  requiresBaseline: boolean,
  options: {
    clock: () => number;
    emit: (event: ScanEvent) => void;
    collectObservations: ReturnType<typeof createDispatchObservationCollector>;
    collectFixes: boolean;
  },
): Promise<CheckExecutionResult> {
  const { clock, emit, collectObservations, collectFixes } = options;
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
      const observations = await collectObservations(adapter, runContext);
      try {
        adapterResult = await observationCheckResult(
          adapter.id,
          observations,
          attributionContext,
          requiresBaseline,
        );
      } catch {
        adapterResult = undefined;
      }
    } else {
      adapterResult = await Reflect.apply(adapter.runLegacy, undefined, [
        runContext,
      ]);
    }
    if (adapterResult === undefined) {
      result = incompleteResult({
        checkId: adapter.id,
        target: target.id,
        durationMs: durationMs(),
        code: "ADAPTER_RESULT_INVALID",
        message: `${label} returned an invalid result for ${target.id === "." ? "the repository root" : target.id}.`,
        remediation: "Run zedbee doctor and update Zedbee before retrying.",
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
          remediation: "Run zedbee doctor and update Zedbee before retrying.",
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
            ...(error.paths === undefined ? {} : { paths: error.paths }),
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
  let displayResult = policyDisplayResult ?? sanitizeCheckResult(result);
  let fixCandidates: readonly CheckFixCandidate[] | undefined;
  if (
    collectFixes &&
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
          findingIds: policyDisplayResult.findings.map((finding) => finding.id),
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
  recordPerformance({
    checkId: adapter.id,
    kind: "elapsed",
    durationMs: displayResult.durationMs,
  });
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
}
