import { scanOutcome } from "../policy/evaluate.js";
import { changeSetFromMap } from "../git/change-set.js";
import type { SnapshotPair } from "../git/snapshot.js";
import { resolveBootstrapResourcePolicy } from "./resource-policy.js";
import type { RunScanDependencies, RunScanOptions } from "./run-scan.js";
import type { ScanReport } from "./report.js";
import type { CheckResult, Finding } from "../core/types.js";
import { summarizeChecks } from "../core/summarize.js";
import { compareCodeUnits } from "../core/compare.js";
import {
  resolveMergeComparison,
  MergeComparisonError,
} from "../git/merge-comparison.js";
import type { ChangeSet, ChangedFile } from "../git/change-set.js";
import {
  createIncompleteReport,
  withUnreportableCleanupFailure,
  DEFAULT_SCAN_PRESENTATION_POLICY,
} from "./incomplete-report.js";
import { sanitizeCheckResult } from "../checks/sanitize-result.js";
import { announceScanPhase } from "./progress.js";
import {
  SelectedIndexCleanupError,
  type SelectedIndexComparison,
} from "../git/selected-comparison.js";

/** Keep each parent's rename and line attribution while scheduling the union of affected paths. */
function comparisonChanges(
  own: ChangeSet,
  all: readonly ChangeSet[],
): ChangeSet {
  const files = new Map<string, ChangedFile>();
  for (const changes of all)
    for (const file of changes.files.values()) {
      const selected = own.files.get(file.path);
      files.set(
        file.path,
        selected ?? {
          path: file.path,
          status: file.status === "deleted" ? "deleted" : "modified",
          addedRanges: [],
        },
      );
    }
  return changeSetFromMap(files);
}

function findingKey(finding: Finding): string {
  return JSON.stringify([finding.id, finding.message, finding.location]);
}

function checkKey(check: CheckResult): string {
  return JSON.stringify([check.checkId, check.target ?? "."]);
}

function isBlockingIncomplete(check: CheckResult): boolean {
  return (
    check.status === "incomplete" && check.incompleteDisposition === "block"
  );
}

/** First check per key, matching what Array.prototype.find returned. */
function checksByKey(report: ScanReport): ReadonlyMap<string, CheckResult> {
  const index = new Map<string, CheckResult>();
  for (const check of report.checks) {
    const key = checkKey(check);
    if (!index.has(key)) index.set(key, check);
  }
  return index;
}

function mergeChecks(reports: readonly ScanReport[]): CheckResult[] {
  const indexes = reports.map(checksByKey);
  const parentEvidence = reports.map(
    (report) => `merge-parent:${report.baseline}`,
  );
  const keys = [...new Set(indexes.flatMap((index) => [...index.keys()]))].sort(
    compareCodeUnits,
  );
  return keys.map((key) => {
    const checks = indexes.map((index) => index.get(key));
    const present = checks.filter(
      (check): check is CheckResult => check !== undefined,
    );
    const durationMs = present.reduce(
      (sum, check) => sum + check.durationMs,
      0,
    );
    const incomplete =
      present.find(isBlockingIncomplete) ??
      present.find((check) => check.status === "incomplete");
    if (incomplete !== undefined) return { ...incomplete, durationMs };
    const first =
      present.find((check) => check.status === "completed") ?? present[0]!;
    if (checks.some((check) => check === undefined))
      return {
        ...first,
        status: "incomplete",
        findings: [],
        incompleteDisposition: "block",
        error: {
          code: "MERGE_COMPARISON_INCOMPLETE",
          message: "A merge check could not be compared against every parent.",
          remediation: "Resolve the missing parent analysis and scan again.",
        },
      };
    if (present.every((check) => check.status === "skipped")) return first;
    // A legitimate not-applicable parent comparison cannot introduce a finding.
    if (present.some((check) => check.status === "skipped"))
      return {
        ...first,
        durationMs,
        findings: [],
      };
    const counts = present.slice(1).map((check) => {
      const count = new Map<string, number>();
      for (const finding of check.findings) {
        const key = findingKey(finding);
        count.set(key, (count.get(key) ?? 0) + 1);
      }
      return count;
    });
    const findings = first.findings
      .filter((finding) => {
        const key = findingKey(finding);
        if (counts.some((count) => (count.get(key) ?? 0) === 0)) return false;
        for (const count of counts) count.set(key, count.get(key)! - 1);
        return true;
      })
      .map((finding) => ({
        ...finding,
        attribution: {
          ...finding.attribution,
          evidence: [...finding.attribution.evidence, ...parentEvidence].sort(
            compareCodeUnits,
          ),
        },
      }));
    return {
      ...first,
      durationMs,
      findings,
    };
  });
}

export async function runMergeScan(
  options: RunScanOptions,
  dependencies: RunScanDependencies,
  scan: (options: RunScanOptions) => Promise<ScanReport>,
  onUnmergedSelection?: (selection: SelectedIndexComparison) => void,
): Promise<ScanReport | undefined> {
  const startedAt = dependencies.now().toISOString();
  const started = dependencies.clock();
  let parents: readonly string[] | undefined;
  let selected: SelectedIndexComparison | undefined;
  let completed: ScanReport | undefined;
  let primaryError: unknown;
  let cleanupFailed = false;
  let sharedTarget: SnapshotPair | undefined;
  let targetMayBeInUse = false;
  const borrowTarget = (
    pair: SnapshotPair,
    cleanup: () => Promise<void>,
  ): SnapshotPair => {
    targetMayBeInUse = true;
    return {
      ...pair,
      async cleanup() {
        // The pair calls this only after its analyzer session settles.
        targetMayBeInUse = false;
        await cleanup();
      },
    };
  };
  const failureReport = (error: unknown): ScanReport => {
    return {
      ...createIncompleteReport(
        {
          repositoryRoot: options.repositoryRoot,
          source: {
            mode: "index",
            baseline: parents?.[0] ?? null,
            target: "index",
          },
          changedFileCount: null,
          startedAt,
          durationMs: Math.max(0, dependencies.clock() - started),
          configuredPathExclusions: [],
          appliedPathExclusions: [],
          networkDisclosures: [],
          presentationPolicy: DEFAULT_SCAN_PRESENTATION_POLICY,
        },
        {
          code:
            error instanceof MergeComparisonError
              ? error.code
              : "MERGE_COMPARISON_FAILED",
          message:
            error instanceof MergeComparisonError
              ? error.message
              : "Zedbee could not compare the staged merge against its parents.",
          remediation:
            "Resolve merge conflicts, verify the parent commits are available locally, and scan again. No merge findings were suppressed.",
        },
      ),
      ...(parents === undefined ? {} : { mergeParents: parents }),
    };
  };
  try {
    if (options.baseRef !== undefined)
      throw new MergeComparisonError("MERGE_PARENTS_INVALID");
    const resourcePolicy = resolveBootstrapResourcePolicy(options);
    let git = dependencies.createGitClient(options.repositoryRoot, {
      resourcePolicy,
    });
    if (dependencies.captureIndexComparison !== undefined) {
      selected = await dependencies.captureIndexComparison(git, options.signal);
      git = selected.bind(git);
    }
    announceScanPhase(
      options.onEvent,
      "baseline-resolution",
      dependencies.clock,
    );
    const comparison = await resolveMergeComparison(
      git,
      options.mergeEnvironment ?? process.env,
      options.merge === "required",
      options.signal,
    );
    if (comparison === undefined) {
      if (selected !== undefined && onUnmergedSelection !== undefined) {
        onUnmergedSelection(selected);
        selected = undefined;
      }
      return undefined;
    }
    parents = comparison.parents;
    announceScanPhase(options.onEvent, "change-discovery", dependencies.clock);
    const changes = await Promise.all(
      parents.map((parent) =>
        dependencies.readCommitChangeSet(
          git,
          parent,
          comparison.tree,
          options.signal,
        ),
      ),
    );
    const reports: ScanReport[] = [];
    let targetInspection:
      Awaited<ReturnType<typeof dependencies.inspectRepository>> | undefined;
    for (const [index, parent] of parents.entries()) {
      options.signal?.throwIfAborted();
      try {
        options.onEvent?.({
          type: "merge-parent",
          checkId: "zedbee",
          target: ".",
          timestamp: dependencies.clock(),
          parent: index + 1,
          total: parents.length,
        });
      } catch {
        // Display observers cannot interrupt merge analysis.
      }
      const changeSet = comparisonChanges(changes[index]!, changes);
      const pairDependencies: RunScanDependencies = {
        ...dependencies,
        // All parent scans already use the one immutable target tree below.
        captureIndexComparison: async () => ({
          baselineCommit: parent,
          bind: (client) => client,
          cleanup: async () => {},
        }),
        loadIndexConfig: (root, client, configPath, signal) =>
          dependencies.loadCommitConfig(
            root,
            client,
            comparison.tree,
            configPath,
            signal,
          ),
        discoverIndexChangeSet: async () => changeSet,
        readIndexChangeSet: async () => changeSet,
        addIndexLineRanges: async () => changeSet,
        buildIndexSnapshots: async (root, client, signal) => {
          if (
            sharedTarget !== undefined &&
            dependencies.buildMergeBaseline !== undefined
          ) {
            const pair = await dependencies.buildMergeBaseline(
              root,
              client,
              parent,
              sharedTarget,
              signal,
            );
            return borrowTarget(pair, () => pair.cleanup());
          }
          const pair = await dependencies.buildCommitSnapshots(
            root,
            client,
            parent,
            comparison.tree,
            signal,
          );
          if (dependencies.buildMergeBaseline === undefined)
            return { ...pair, targetRef: "index" };
          sharedTarget = { ...pair, targetRef: "index" };
          return borrowTarget(sharedTarget, async () => {});
        },
        async inspectRepository(root) {
          if (root !== sharedTarget?.targetDir)
            return dependencies.inspectRepository(root);
          return (targetInspection ??=
            await dependencies.inspectRepository(root));
        },
      };
      const {
        merge: _merge,
        mergeEnvironment: _environment,
        ...pairOptions
      } = options;
      reports.push(
        await scan({
          ...pairOptions,
          dependencies: pairDependencies,
          onEvent(event) {
            if (event.type === "check-completed") {
              const { checkId, target, timestamp } = event;
              options.onEvent?.({
                type: "parent-check-settled",
                checkId,
                target,
                timestamp,
              });
            } else options.onEvent?.(event);
          },
        }),
      );
      const report = reports.at(-1)!;
      if (
        report.checks.some(
          (check) => check.error?.code === "SNAPSHOT_CLEANUP_FAILED",
        )
      ) {
        // Parent findings stay provisional until every comparison has settled.
        const checks = report.checks.filter(
          ({ status }) => status === "incomplete",
        );
        return (completed = {
          ...report,
          baseline: parents[0]!,
          exitCode: 2,
          outcome: "incomplete",
          mergeParents: parents,
          checks,
          summary: summarizeChecks(checks),
        });
      }
    }
    const checks = mergeChecks(reports);
    for (const result of checks) {
      try {
        options.onEvent?.({
          type: "check-completed",
          checkId: result.checkId,
          target: result.target ?? ".",
          timestamp: dependencies.clock(),
          result: sanitizeCheckResult(result),
        });
      } catch {
        // Display observers must not change the merge outcome.
      }
    }
    const summary = summarizeChecks(checks);
    const blockingIncomplete =
      reports.some((report) => report.exitCode === 2) ||
      checks.some(isBlockingIncomplete);
    const { changeSummary: _pairwiseSummary, ...firstReport } = reports[0]!;
    return (completed = {
      ...firstReport,
      mergeParents: parents,
      checks,
      summary,
      ...scanOutcome(summary, blockingIncomplete),
      startedAt,
      durationMs: Math.max(0, dependencies.clock() - started),
      networkDisclosures: reports.flatMap(
        (report) => report.networkDisclosures,
      ),
    });
  } catch (error) {
    if (error instanceof SelectedIndexCleanupError) {
      cleanupFailed = true;
      error = error.originalError;
    }
    primaryError = error;
    if (options.signal?.aborted) throw error;
    completed = failureReport(error);
    return completed;
  } finally {
    if (!targetMayBeInUse) {
      try {
        await sharedTarget?.cleanup();
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await selected?.cleanup();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      if (options.signal?.aborted)
        throw new SelectedIndexCleanupError(
          primaryError ?? options.signal.reason,
        );
      return withUnreportableCleanupFailure(
        completed ?? failureReport(new Error("Selected input cleanup failed")),
        Math.max(0, dependencies.clock() - started),
      );
    }
  }
}
