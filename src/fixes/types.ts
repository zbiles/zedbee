import type { FormattingSettings } from "../checks/prettier/settings.js";

export const FIXABLE_CHECK_IDS = Object.freeze([
  "formatting",
  "lint",
  "reactCorrectness",
] as const);

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
  readonly fixes: number;
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
