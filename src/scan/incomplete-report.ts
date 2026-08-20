import { sanitizeCheckResult } from "../checks/sanitize-result.js";
import { summarizeChecks } from "../core/summarize.js";
import type { CheckResult } from "../core/types.js";
import type { ValidatedSnapshotPath } from "../git/snapshot-path.js";
import type {
  NetworkDisclosure,
  ScanPresentationPolicy,
  ScanReport,
} from "./report.js";

export interface ScanFailureInput {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly remediation: string;
}

export interface ScanReportContext {
  readonly repositoryRoot: string;
  readonly baseline: "HEAD" | null;
  readonly stagedFileCount: number | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly networkDisclosures: readonly NetworkDisclosure[];
  readonly presentationPolicy: ScanPresentationPolicy;
}

function incompleteCheck(
  failure: ScanFailureInput,
  durationMs: number,
): CheckResult {
  return sanitizeCheckResult({
    checkId: "zedbee",
    status: "incomplete",
    durationMs,
    findings: [],
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.path === undefined ? {} : { path: failure.path }),
      remediation: failure.remediation,
    },
  });
}

export function createIncompleteReport(
  context: ScanReportContext,
  failure: ScanFailureInput | readonly ScanFailureInput[],
): ScanReport {
  const failures = Array.isArray(failure) ? failure : [failure];
  const results = failures.map((item) =>
    incompleteCheck(item, context.durationMs),
  );
  return {
    schemaVersion: 1,
    outcome: "incomplete",
    exitCode: 2,
    repositoryRoot: context.repositoryRoot,
    baseline: context.baseline,
    target: "index",
    stagedFileCount: context.stagedFileCount,
    startedAt: context.startedAt,
    durationMs: context.durationMs,
    networkDisclosures: context.networkDisclosures,
    presentationPolicy: context.presentationPolicy,
    summary: summarizeChecks(results),
    checks: results,
  };
}

function appendCleanupFailure(
  report: ScanReport,
  durationMs: number,
  failure: Readonly<{ message: string; remediation: string }>,
  snapshotRoot?: ValidatedSnapshotPath,
): ScanReport {
  const cleanupResult = sanitizeCheckResult(
    {
      checkId: "zedbee",
      status: "incomplete",
      durationMs,
      findings: [],
      error: {
        code: "SNAPSHOT_CLEANUP_FAILED",
        message: failure.message,
        remediation: failure.remediation,
      },
    },
    snapshotRoot === undefined ? {} : { temporaryPath: snapshotRoot },
  );
  const checks = [...report.checks, cleanupResult];
  return {
    ...report,
    outcome: "incomplete",
    exitCode: 2,
    durationMs,
    summary: summarizeChecks(checks),
    checks,
  };
}

export function withCleanupFailure(
  report: ScanReport,
  snapshotRoot: ValidatedSnapshotPath,
  durationMs: number,
): ScanReport {
  return appendCleanupFailure(
    report,
    durationMs,
    {
      message: "Zedbee could not remove its temporary snapshot.",
      remediation:
        "Inspect and remove the listed Zedbee snapshot, then verify temporary-directory permissions or locks. A persistent filesystem or path-identity problem can cause later cleanups to fail and leave additional snapshots.",
    },
    snapshotRoot,
  );
}

export function withUnreportableCleanupFailure(
  report: ScanReport,
  durationMs: number,
): ScanReport {
  return appendCleanupFailure(report, durationMs, {
    message:
      "Zedbee could not remove its temporary snapshot or safely identify the remaining directory.",
    remediation:
      "Inspect the OS temporary directory for zedbee-snapshot-* directories and remove any stale Zedbee snapshots, then verify temporary-directory permissions or locks. A persistent filesystem or path-identity problem can cause later cleanups to fail and leave additional snapshots.",
  });
}
