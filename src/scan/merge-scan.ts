import { resolveScanResourcePolicy } from "./resource-policy.js";
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
import { createIncompleteReport } from "./incomplete-report.js";
import { EMPTY_AGENT_GUIDANCE } from "../reporting/agent-guidance.js";
import { sanitizeCheckResult } from "../checks/sanitize-result.js";

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
  return {
    files,
    isEmpty: files.size === 0,
    containsAddedLine(file, line) {
      return (
        files
          .get(file)
          ?.addedRanges.some(
            (range) => range.start <= line && line <= range.end,
          ) ?? false
      );
    },
  };
}

function findingKey(finding: Finding): string {
  return JSON.stringify([finding.id, finding.message, finding.location]);
}

function checkKey(check: CheckResult): string {
  return JSON.stringify([check.checkId, check.target ?? "."]);
}

function mergeChecks(reports: readonly ScanReport[]): CheckResult[] {
  const keys = [
    ...new Set(reports.flatMap((report) => report.checks.map(checkKey))),
  ].sort(compareCodeUnits);
  return keys.map((key) => {
    const checks = reports.map((report) =>
      report.checks.find((check) => checkKey(check) === key),
    );
    const present = checks.filter(
      (check): check is CheckResult => check !== undefined,
    );
    const incomplete =
      present.find(
        (check) =>
          check.status === "incomplete" &&
          check.incompleteDisposition === "block",
      ) ?? present.find((check) => check.status === "incomplete");
    if (incomplete !== undefined)
      return {
        ...incomplete,
        durationMs: present.reduce((sum, check) => sum + check.durationMs, 0),
      };
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
        durationMs: present.reduce((sum, check) => sum + check.durationMs, 0),
        findings: [],
      };
    const counts = present.slice(1).map((check) => {
      const count = new Map<string, number>();
      for (const finding of check.findings)
        count.set(
          findingKey(finding),
          (count.get(findingKey(finding)) ?? 0) + 1,
        );
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
          evidence: [
            ...finding.attribution.evidence,
            ...reports.map((report) => `merge-parent:${report.baseline}`),
          ].sort(compareCodeUnits),
        },
      }));
    return {
      ...first,
      durationMs: present.reduce((sum, check) => sum + check.durationMs, 0),
      findings,
    };
  });
}

export async function runMergeScan(
  options: RunScanOptions,
  dependencies: RunScanDependencies,
  scan: (options: RunScanOptions) => Promise<ScanReport>,
): Promise<ScanReport | undefined> {
  const startedAt = dependencies.now().toISOString();
  const started = dependencies.clock();
  let parents: readonly string[] | undefined;
  try {
    if (options.baseRef !== undefined)
      throw new MergeComparisonError("MERGE_PARENTS_INVALID");
    const resourcePolicy = resolveScanResourcePolicy(
      { gitHardTimeout: "30s" },
      {
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.noTimeout ? { noTimeout: true } : {}),
      },
    );
    const git = dependencies.createGitClient(options.repositoryRoot, {
      resourcePolicy,
    });
    const comparison = await resolveMergeComparison(
      git,
      options.mergeEnvironment ?? process.env,
      options.merge === "required",
      options.signal,
    );
    if (comparison === undefined) return undefined;
    parents = comparison.parents;
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
    const progress = new Set<string>();
    for (const [index, parent] of parents.entries()) {
      options.signal?.throwIfAborted();
      const changeSet = comparisonChanges(changes[index]!, changes);
      const pairDependencies: RunScanDependencies = {
        ...dependencies,
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
        buildIndexSnapshots: async (root, client, signal) => ({
          ...(await dependencies.buildCommitSnapshots(
            root,
            client,
            parent,
            comparison.tree,
            signal,
          )),
          targetRef: "index",
        }),
        dispatch: (adapters, context, dispatchOptions) =>
          dependencies.dispatch(
            adapters,
            { ...context, mergeComparison: true },
            dispatchOptions,
          ),
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
            // Parent results are provisional; only the combined result is final.
            if (event.type === "check-completed") return;
            if (
              event.type === "check-queued" ||
              event.type === "check-running"
            ) {
              const key = JSON.stringify([
                event.type,
                event.checkId,
                event.target,
              ]);
              if (progress.has(key)) return;
              progress.add(key);
            }
            options.onEvent?.(event);
          },
        }),
      );
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
    const blockingIncomplete = checks.some(
      (check) =>
        check.status === "incomplete" &&
        check.incompleteDisposition === "block",
    );
    return {
      ...reports[0]!,
      mergeParents: parents,
      checks,
      summary,
      exitCode: blockingIncomplete ? 2 : summary.failed > 0 ? 1 : 0,
      outcome: blockingIncomplete
        ? "incomplete"
        : summary.failed > 0
          ? "blocked"
          : "pass",
      startedAt,
      durationMs: Math.max(0, dependencies.clock() - started),
      networkDisclosures: reports.flatMap(
        (report) => report.networkDisclosures,
      ),
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
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
          presentationPolicy: {
            terminalFindingLimit: 25,
            temporaryReportMaxAge: "24h",
            persistSourceExcerpts: false,
            agentGuidance: EMPTY_AGENT_GUIDANCE,
          },
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
  }
}
