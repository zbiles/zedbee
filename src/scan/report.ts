import type { LocalScanDiagnostics } from "../diagnostics/local-scan-diagnostics.js";
import type { ChangeSummary } from "./change-summary.js";
import type { CheckResult, RunSummary } from "../core/types.js";
import type { AgentGuidance } from "../reporting/agent-guidance.js";
import type { ScanMode } from "./source-mode.js";
import type { PathExclusion } from "../config/schema.js";
import type { HookUpdateNotice } from "../reporting/hook-update-notice.js";

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
  readonly agentGuidance: AgentGuidance;
}

export interface ScanReport {
  readonly schemaVersion: 1;
  /** Bounded local timings for this scan; not CPU or whole-command measurements. */
  readonly diagnostics?: LocalScanDiagnostics;
  outcome: "pass" | "blocked" | "incomplete";
  exitCode: 0 | 1 | 2;
  repositoryRoot: string;
  /** Host-resolved output guidance only; analyzer/cache commands stay canonical. */
  readonly installedCliCommand?: readonly string[];
  /** Local hook maintenance advice, independent of analyzer findings/outcome. */
  readonly hookUpdate?: HookUpdateNotice;
  readonly mode: ScanMode;
  readonly mergeParents?: readonly string[];
  readonly baseline: "HEAD" | string | null;
  readonly target: "index" | string | null;
  readonly requestedBase?: string;
  /** Number of changed paths, or null when change discovery failed. */
  readonly changedFileCount: number | null;
  readonly changeSummary?: ChangeSummary;
  startedAt: string;
  durationMs: number;
  networkDisclosures: readonly NetworkDisclosure[];
  readonly configuredPathExclusions: readonly PathExclusion[];
  readonly appliedPathExclusions: readonly PathExclusion[];
  readonly presentationPolicy: ScanPresentationPolicy;
  summary: RunSummary;
  checks: readonly CheckResult[];
}
