export function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** The parent retains this group identity before any engine can start. */
export async function stopProcessGroup(pid: number): Promise<void> {
  if (!processGroupAlive(pid)) return;
  signalProcessGroup(pid, "SIGTERM");
  const forceAt = performance.now() + 2_000;
  let forced = false;
  while (processGroupAlive(pid)) {
    if (!forced && performance.now() >= forceAt) {
      signalProcessGroup(pid, "SIGKILL");
      forced = true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
