import type { ScanPhase } from "../checks/events.js";

export const SCAN_PHASE_LABELS: Record<ScanPhase, string> = {
  configuration: "Reading scan configuration",
  "baseline-resolution": "Resolving comparison baseline",
  "change-discovery": "Reading changed files and lines",
  "snapshot-construction": "Building scan snapshots",
  "baseline-inspection": "Inspecting previous project snapshot",
  "target-inspection": "Inspecting changed project snapshot",
  "project-inspection": "Inspecting project snapshots",
  "source-capture": "Preparing analyzer inputs",
  dispatch: "Planning checks",
  "policy-evaluation": "Preparing scan results",
  cleanup: "Cleaning up scan resources",
};
