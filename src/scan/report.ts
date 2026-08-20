import type { CheckResult, RunSummary } from "../core/types.js";

export interface NetworkDisclosure {
  readonly checkId: string;
  readonly target: string;
  readonly services: readonly string[];
  readonly metadata: readonly string[];
}

export interface ScanPresentationPolicy {
  readonly terminalFindingLimit: number | "all";
  readonly temporaryReportMaxAge: string;
  readonly persistSourceExcerpts: boolean;
}

export interface ScanReport {
  schemaVersion: 1;
  outcome: "pass" | "blocked" | "incomplete";
  exitCode: 0 | 1 | 2;
  repositoryRoot: string;
  baseline: "HEAD" | null;
  target: "index";
  /** Number of paths in the staged index, or null when change discovery failed. */
  stagedFileCount: number | null;
  startedAt: string;
  durationMs: number;
  networkDisclosures: readonly NetworkDisclosure[];
  readonly presentationPolicy: ScanPresentationPolicy;
  summary: RunSummary;
  checks: readonly CheckResult[];
}
