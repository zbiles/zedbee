import type { CheckResult } from "../core/types.js";

interface CheckEventBase {
  checkId: string;
  target: string;
  timestamp: number;
}

export interface CheckQueuedEvent extends CheckEventBase {
  type: "check-queued";
}

export interface CheckRunningEvent extends CheckEventBase {
  type: "check-running";
}

export interface CheckCompletedEvent extends CheckEventBase {
  type: "check-completed";
  result: CheckResult;
}

export interface NetworkDisclosureEvent extends CheckEventBase {
  type: "network-disclosure";
  services: readonly string[];
  metadata: readonly string[];
}

export interface GitSoftTimeoutEvent extends CheckEventBase {
  type: "git-soft-timeout";
}

/** Scan work outside individual checks; never contributes to check counts. */
export type ScanPhase =
  | "configuration"
  | "baseline-resolution"
  | "change-discovery"
  | "snapshot-construction"
  | "baseline-inspection"
  | "target-inspection"
  | "source-capture"
  | "dispatch"
  | "policy-evaluation"
  | "cleanup";

export interface ScanPhaseEvent extends CheckEventBase {
  type: "scan-phase";
  phase: ScanPhase;
}

export type ScanEvent =
  | CheckQueuedEvent
  | CheckRunningEvent
  | CheckCompletedEvent
  | NetworkDisclosureEvent
  | GitSoftTimeoutEvent
  | ScanPhaseEvent;
