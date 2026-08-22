import type { CheckResult, Observation } from "../core/types.js";
import type { ResolvedCheckPolicy, ResolvedConfig } from "../config/schema.js";
import type { ChangeSet } from "../git/change-set.js";
import type { SnapshotPair } from "../git/snapshot.js";
import type { RepositoryInspection } from "../inspection/types.js";
import type { FilePolicyResolver } from "../config/file-policy.js";

export type ExecutionClass = "lightweight" | "project-analysis" | "network";

export interface CheckTarget {
  readonly id: string;
  readonly kind: "repository" | "workspace";
  readonly relativeRoot: string;
}

/**
 * Snapshot-paired analyzer output. Task 7 wires normalized observations through
 * this contract; legacy finding adapters continue returning CheckResult meanwhile.
 */
export interface CheckObservationSet<TObservation = Observation> {
  readonly checkId: string;
  readonly target: CheckTarget;
  readonly baselineObservations: readonly TObservation[];
  readonly targetObservations: readonly TObservation[];
  /** A changed project input can own target-only findings away from edited lines. */
  readonly projectDelta?: boolean;
}

export interface InspectionContext {
  repositoryRoot: string;
  changeSet: ChangeSet;
  config: ResolvedConfig;
  baselineInspection: RepositoryInspection;
  targetInspection: RepositoryInspection;
}

/** Internal dispatcher-to-policy-evaluator contract. */
export interface CheckExecutionResult {
  readonly result: CheckResult;
  readonly target?: CheckTarget;
  /** A null policy marks a dispatcher failure that must remain visible. */
  readonly policy: Readonly<ResolvedCheckPolicy> | null;
  readonly policyForFile?: FilePolicyResolver;
}

export type CheckApplicability =
  | { applies: false; reason: string }
  | {
      applies: true;
      executionClass: ExecutionClass;
      requiresBaseline: boolean;
      targets: readonly CheckTarget[];
      networkDisclosure?: {
        readonly services: readonly string[];
        readonly metadata: readonly string[];
      };
    };

export interface CheckRunContext extends InspectionContext {
  /** Read-only paths only; adapters never receive snapshot cleanup authority. */
  readonly snapshots: Readonly<Omit<SnapshotPair, "cleanup">>;
  readonly target: CheckTarget;
  readonly policy: Readonly<ResolvedCheckPolicy>;
  readonly policyForFile: FilePolicyResolver;
  readonly signal: AbortSignal;
}

interface CheckAdapterBase {
  readonly id: string;
  /**
   * Runs before targets are known. The dispatcher supplies the most
   * permissive potentially enabled `when` value for this check; `run`
   * receives the exact inspected-target policy.
   */
  inspect(context: InspectionContext): Promise<CheckApplicability>;
}

export interface ObservationCheckAdapter extends CheckAdapterBase {
  readonly output: "observations";
  collect(context: CheckRunContext): Promise<CheckObservationSet>;
}

/**
 * Narrow compatibility boundary for Prettier's already-attributed
 * transformation findings. New managed adapters return observations.
 */
export interface LegacyCheckResultAdapter extends CheckAdapterBase {
  readonly id: "formatting";
  readonly output: "legacy-check-result";
  runLegacy(context: CheckRunContext): Promise<CheckResult>;
}

export type CheckAdapter = ObservationCheckAdapter | LegacyCheckResultAdapter;
