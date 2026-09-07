export interface ProcessExitStatus {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** The Windows worker and taskkill must both close before this is evaluated.
 * Successful taskkill is cleanup evidence, not Job Object ownership evidence. */
export function workerExitedAbnormally(
  exit: ProcessExitStatus,
  termination: {
    readonly platform: NodeJS.Platform;
    readonly requested: boolean;
    readonly windowsKiller?: ProcessExitStatus;
  },
): boolean {
  const intentionalWindowsTermination =
    termination.platform === "win32" &&
    termination.requested &&
    exit.code === 1 &&
    exit.signal === null &&
    termination.windowsKiller?.code === 0 &&
    termination.windowsKiller.signal === null;
  return (
    (exit.code !== null && exit.code !== 0 && !intentionalWindowsTermination) ||
    (exit.signal !== null &&
      (!termination.requested ||
        (exit.signal !== "SIGTERM" && exit.signal !== "SIGKILL")))
  );
}
