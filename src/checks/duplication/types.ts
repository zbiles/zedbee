import type { Observation, SourceLocation } from "../../core/types.js";

export interface JscpdFileFragment {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly startLoc: {
    readonly line: number;
    readonly column: number;
    readonly position: number;
  };
  readonly endLoc: {
    readonly line: number;
    readonly column: number;
    readonly position: number;
  };
}

export interface JscpdClone {
  readonly firstFile: JscpdFileFragment;
  readonly secondFile: JscpdFileFragment;
  readonly fragment: string;
  readonly lines: number;
  readonly tokens: number;
  readonly format: string;
}

export interface JscpdReport {
  readonly duplicates: readonly JscpdClone[];
  readonly statistics: {
    readonly total: {
      readonly percentage: number;
      readonly percentageTokens: number;
    };
  };
}

export interface NormalizedCloneFragment extends SourceLocation {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface NormalizedClone {
  readonly identity: string;
  readonly tokenHash: string;
  readonly tokens: number;
  readonly fragments: readonly [
    NormalizedCloneFragment,
    NormalizedCloneFragment,
  ];
}

export interface NormalizedDuplicationReport {
  readonly percentage: number;
  readonly clones: readonly NormalizedClone[];
}

export type DuplicationObservation = Observation;
