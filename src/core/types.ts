export type Severity = "info" | "warning" | "error";
export type CheckStatus = "completed" | "skipped" | "incomplete";
export type IncompleteDisposition = "block" | "warn";

export interface SourceLocation {
  file: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface Attribution {
  kind:
    | "range-overlap"
    | "syntax-ownership"
    | "transformation-diff"
    | "baseline-comparison"
    | "metric-delta"
    | "none";
  staged: boolean;
  evidence: readonly string[];
}

export interface SourceExcerpt {
  readonly line: number;
  readonly text?: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

/** Source-free guidance for a fresh managed fix operation. */
export interface ManagedAutomaticFix {
  readonly available: true;
  readonly command: readonly string[];
  readonly scope: "finding" | "working-file";
  readonly writes: "working-tree";
  readonly stagesChanges: false;
}

export interface Finding {
  id: string;
  check: string;
  rule: string;
  severity: Severity;
  message: string;
  location?: SourceLocation;
  remediation?: string;
  automaticFix?: ManagedAutomaticFix;
  sourceExcerpt?: SourceExcerpt;
  attribution: Attribution;
}

export interface ObservationEntity {
  readonly kind: string;
  readonly name: string;
  readonly file: string;
}

/** A syntax entity whose complete declaration span intersects staged lines. */
export interface ChangedEntity extends ObservationEntity {
  readonly startLine: number;
  readonly endLine: number;
  /** Canonical, secret-safe identity shared with matching observations. */
  readonly identity: string;
}

export interface ObservationMetric {
  readonly name: string;
  readonly value: number;
  readonly limit?: number;
}

export interface Observation {
  readonly check: string;
  readonly rule: string;
  /** Canonical, secret-safe identity supplied by the managed adapter. */
  readonly identity: string;
  /**
   * Ephemeral, non-reportable discriminator used only while pairing baseline
   * and target observations. It must never affect a public finding id.
   */
  readonly comparisonIdentity?: string;
  readonly severity: Severity;
  readonly message: string;
  readonly location?: SourceLocation;
  readonly entity?: ObservationEntity;
  readonly metric?: ObservationMetric;
  readonly remediation?: string;
  readonly automaticFix?: ManagedAutomaticFix;
}

export type FindingIdentityScope =
  | {
      readonly kind: "location";
      readonly file: string;
      readonly startLine?: number;
      readonly startColumn?: number;
      readonly endLine?: number;
      readonly endColumn?: number;
    }
  | {
      readonly kind: "entity";
      readonly entityKind: string;
      readonly name: string;
      readonly file: string;
    }
  | { readonly kind: "repository" };

/** The complete, prose-free input to a stable finding fingerprint. */
export interface FindingIdentity {
  readonly check: string;
  readonly rule: string;
  readonly identity: string;
  readonly scope: FindingIdentityScope;
  readonly metricName?: string;
}

export interface CheckError {
  readonly diagnostic?: import("../checks/diagnostics.js").AnalyzerDiagnostic;
  code: string;
  message: string;
  path?: string;
  paths?: readonly string[];
  snapshot?: "last-commit" | "staged";
  projectPaths?: readonly string[];
  temporaryPath?: string;
  remediation?: string;
}

export interface CheckResult {
  checkId: string;
  target?: string;
  status: CheckStatus;
  durationMs: number;
  findings: readonly Finding[];
  error?: CheckError;
  skipReason?: string;
  incompleteDisposition?: IncompleteDisposition;
}

export interface RunSummary {
  passed: number;
  warnings: number;
  failed: number;
  incomplete: number;
  findings: readonly Finding[];
}
