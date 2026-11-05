import pLimit from "p-limit";
import {
  CHECK_IDS,
  type CheckId,
  type ResolvedCheckPolicy,
} from "../config/schema.js";
import type {
  CheckAdapter,
  CheckExecutionResult,
  InspectionContext,
} from "./adapter.js";
import type { ScanEvent } from "./events.js";
import { sanitizeCheckResult } from "./sanitize-result.js";
import { incompleteResult } from "./incomplete-result.js";
import { CheckIncompleteError } from "./incomplete-error.js";
import { compareCodeUnits } from "../core/compare.js";
import { checkLabel } from "../core/check-label.js";
import type { ObservationCache } from "../cache/store.js";
import {
  resolveInspectionPolicy,
  resolveScheduledTargetPolicy,
} from "./policy-scheduling.js";
import {
  adapterBaseContext,
  immutablePolicy,
  inspectionContext,
  type DispatchContext,
} from "./dispatch-context.js";
import { snapshotAdapter, snapshotApplicability } from "./dispatch-adapter.js";
import { createDispatchObservationCollector } from "./dispatch-cache.js";
import { executeDispatchTarget, executionResult } from "./dispatch-target.js";

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

function compareResults(
  left: CheckExecutionResult,
  right: CheckExecutionResult,
): number {
  return (
    compareCodeUnits(left.result.checkId, right.result.checkId) ||
    compareCodeUnits(left.result.target ?? "", right.result.target ?? "")
  );
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
  // Bounded producers retain only four active adapter inputs. Worker/class
  // scheduling belongs to the shared executor, including its four-worker mode.
  const limit = pLimit(4);
  const adapterContext = adapterBaseContext(context);
  const collectObservations = createDispatchObservationCollector(
    adapterContext,
    options,
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
    } catch (error) {
      const label = checkLabel(adapter.id);
      scheduled.push(
        Promise.resolve(
          executionResult(
            error instanceof CheckIncompleteError
              ? incompleteResult({
                  checkId: adapter.id,
                  durationMs: 0,
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
                  durationMs: 0,
                  code: "ADAPTER_INSPECTION_FAILED",
                  message: `${label} could not determine whether it applies.`,
                  remediation:
                    "Check the repository configuration and run zedbee doctor.",
                }),
            error instanceof CheckIncompleteError
              ? inspectExecutionPolicy
              : null,
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
      scheduled.push(
        limit(() =>
          executeDispatchTarget(
            adapter,
            adapterContext,
            target,
            executionPolicy,
            applicability.requiresBaseline,
            {
              clock,
              emit,
              collectObservations,
              collectFixes: options.collectFixes === true,
            },
          ),
        ),
      );
    }
  }

  return (await Promise.all(scheduled)).sort(compareResults);
}
