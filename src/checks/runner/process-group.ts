import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** POSIX has no group-member count syscall; use the fixed OS process inventory. */
export async function processGroupHasDescendants(
  pid: number,
): Promise<boolean> {
  const { stdout } = await promisify(execFile)(
    "/bin/ps",
    ["-axo", "pid=,pgid="],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 2_000,
      killSignal: "SIGKILL",
    },
  );
  return stdout
    .trim()
    .split("\n")
    .some((line) => {
      if (!/^\s*\d+\s+\d+\s*$/u.test(line))
        throw new Error("Invalid process inventory");
      const [member, group] = line.trim().split(/\s+/u).map(Number);
      return group === pid && member !== pid;
    });
}

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
