import type { CheckResult, RunSummary } from "../core/types.js";

export interface NetworkDisclosure {
  readonly checkId: string;
  readonly target: string;
  readonly services: readonly string[];
  readonly metadata: readonly string[];
}

export interface ScanReport {
  schemaVersion: 1;
  outcome: "pass" | "blocked" | "incomplete";
  exitCode: 0 | 1 | 2;
  repositoryRoot: string;
  baseline: "HEAD" | null;
  target: "index";
  startedAt: string;
  durationMs: number;
  networkDisclosures: readonly NetworkDisclosure[];
  summary: RunSummary;
  checks: readonly CheckResult[];
}
