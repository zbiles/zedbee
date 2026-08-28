import type { FormattingSettings } from "../checks/prettier/settings.js";

export const FIXABLE_CHECK_IDS = Object.freeze([
  "formatting",
  "lint",
  "reactCorrectness",
] as const);

/** Number of file actions the interactive confirmation can show at once. */
export const FIX_PLAN_FILE_SUMMARY_LIMIT = 12;

export type FixableCheckId = (typeof FIXABLE_CHECK_IDS)[number];

export interface ExactFixEdit {
  readonly findingId: string;
  readonly severity: "warning" | "error";
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface ExactFileFixCandidate {
  readonly kind: "exact-file";
  readonly checkId: "lint" | "reactCorrectness";
  readonly file: string;
  readonly baseSource: string;
  readonly edits: readonly ExactFixEdit[];
}

export interface FormatFileFixCandidate {
  readonly kind: "format-file";
  readonly checkId: "formatting";
  readonly file: string;
  readonly findingIds: readonly string[];
  readonly severities: readonly ("warning" | "error")[];
  readonly settings: Readonly<FormattingSettings>;
}

export type CheckFixCandidate = ExactFileFixCandidate | FormatFileFixCandidate;

export interface FixPlanItem {
  readonly checkId: FixableCheckId;
  readonly file: string;
  readonly findingIds: readonly string[];
  readonly scope: "finding" | "working-file";
  readonly blocking: number;
  readonly warnings: number;
  /** Present on freshly built plans; optional only for private legacy fixtures. */
  readonly status?: "applicable" | "skipped";
  /** Source-free explanation required when status is skipped. */
  readonly reason?: string;
}

export interface FixPlanSummary {
  readonly fixes: number;
  readonly files: number;
  readonly blocking: number;
  readonly warnings: number;
  readonly skipped: number;
}

export interface FixPlanFile {
  readonly path: string;
  /** Individual exact edits plus at most one formatting action. */
  readonly fixes: number;
  /** Present on freshly built plans; optional only for private legacy fixtures. */
  readonly applicableFixes?: number;
  readonly skippedFixes?: number;
  readonly status?: "applicable" | "partial" | "skipped";
  readonly reasons?: readonly string[];
  readonly hasUnstagedChanges: boolean;
}

/** A source-free, JSON-safe summary of a fresh staged fix analysis. */
export interface FixPlan {
  readonly schemaVersion: 1;
  readonly target: "index";
  readonly selectedChecks: readonly FixableCheckId[];
  /** An incomplete selected check produces exit status 2. */
  readonly exitCode: 0 | 2;
  readonly summary: FixPlanSummary;
  readonly files: readonly FixPlanFile[];
  readonly items: readonly FixPlanItem[];
}

/**
 * Private execution material deliberately kept out of `FixPlan` serializers.
 * Consumers may use it only in the same process that performed the analysis.
 */
export interface WorkingFilePreview {
  readonly path: string;
  readonly sha256: string;
  readonly content: string;
  readonly mode: number;
  readonly hasUnstagedChanges: boolean;
}

export interface PreparedFixPlan {
  readonly publicPlan: FixPlan;
  readonly repositoryRoot: string;
  readonly candidates: readonly CheckFixCandidate[];
  readonly workingFiles: ReadonlyMap<string, WorkingFilePreview>;
  readonly temporaryReportMaxAgeMs: number;
}

export type FixIssueKind = "conflict" | "stale" | "write" | "format";

export interface FixIssue {
  readonly kind: FixIssueKind;
  readonly file: string;
  readonly checkIds: readonly FixableCheckId[];
  readonly message: string;
  readonly remediation: string;
}

export interface FixResult {
  readonly exitCode: 0 | 1;
  readonly appliedFixes: number;
  readonly changedFiles: readonly string[];
  readonly unchangedFiles: readonly string[];
  readonly issues: readonly FixIssue[];
}
