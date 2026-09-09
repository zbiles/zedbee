export interface ProcessExitStatus {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

// Deliberately outside ordinary analyzer exit statuses. TerminateJobObject sets
// this exact status; it does not replace a process's already-recorded crash code.
export const WINDOWS_JOB_TERMINATION_EXIT_CODE = 0x5a454442;

export function workerExitedAbnormally(
  exit: ProcessExitStatus,
  termination: {
    readonly platform: NodeJS.Platform;
    readonly requested: boolean;
  },
): boolean {
  const intentionalWindowsTermination =
    termination.platform === "win32" &&
    termination.requested &&
    exit.code === WINDOWS_JOB_TERMINATION_EXIT_CODE &&
    exit.signal === null;
  return (
    (exit.code !== null && exit.code !== 0 && !intentionalWindowsTermination) ||
    (exit.signal !== null &&
      (!termination.requested ||
        (exit.signal !== "SIGTERM" && exit.signal !== "SIGKILL")))
  );
}
