import type { ScanEvent, ScanPhase } from "../checks/events.js";

/** Presentation observers cannot change analysis or prevent resource cleanup. */
export function announceScanPhase(
  onEvent: ((event: ScanEvent) => void) | undefined,
  phase: ScanPhase,
  clock: () => number,
): void {
  if (onEvent === undefined) return;
  try {
    onEvent({
      type: "scan-phase",
      checkId: "zedbee",
      target: ".",
      timestamp: clock(),
      phase,
    });
  } catch {
    // The observer owns display failure; scanning and cleanup must continue.
  }
}
