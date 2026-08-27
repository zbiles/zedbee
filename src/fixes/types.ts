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
