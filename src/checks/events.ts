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

export type ScanEvent =
  | CheckQueuedEvent
  | CheckRunningEvent
  | CheckCompletedEvent
  | NetworkDisclosureEvent;
