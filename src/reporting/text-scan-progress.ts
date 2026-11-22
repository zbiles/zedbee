import type { ScanEvent, ScanPhase } from "../checks/events.js";
import { checkLabel } from "../core/check-label.js";
import { displayLabel } from "../core/display-text.js";
import { SCAN_PHASE_LABELS } from "./scan-phase-labels.js";

const INTERVAL_MS = 30_000;

/** Text output is also used by hooks whose stdout and stderr are captured. */
export function createTextScanProgress(write: (line: string) => void) {
  const active = new Map<string, string>();
  let phase: ScanPhase | undefined;
  let parent: string | undefined;
  return {
    update(event: ScanEvent): void {
      const key = JSON.stringify([event.checkId, event.target]);
      if (event.type === "scan-phase") {
        phase = event.phase;
      } else if (event.type === "merge-parent") {
        parent = `parent ${event.parent} of ${event.total}`;
        phase = undefined;
        active.clear();
      } else if (event.type === "check-running") {
        const check = displayLabel(checkLabel(event.checkId), "check");
        const target = displayLabel(event.target, "check target");
        active.set(key, target === "." ? check : `${check} (${target})`);
      } else if (
        event.type === "check-completed" ||
        event.type === "parent-check-settled"
      ) {
        active.delete(key);
      }
    },
    start(): () => void {
      const started = performance.now();
      const timer = setInterval(() => {
        const elapsed = Math.max(INTERVAL_MS, performance.now() - started);
        const details = [
          `Swarm is still scanning (${Math.floor(elapsed / 1000)}s)`,
          parent,
          active.size === 0
            ? phase === undefined
              ? undefined
              : SCAN_PHASE_LABELS[phase]
            : [...active.values()].slice(0, 2).join(", ") +
              (active.size > 2 ? ` +${active.size - 2} more` : ""),
        ];
        try {
          write(
            details.filter((detail) => detail !== undefined).join(" · ") + "\n",
          );
        } catch {
          // Progress output is advisory.
        }
      }, INTERVAL_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
