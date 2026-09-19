import { stopProcessGroup } from "../runner/process-group.js";
import type { WindowsJob } from "../runner/windows-job.js";

/** Own the OS lifetime before the bootstrap may import any project code. */
export class ProjectProcessOwner {
  private pid: number | undefined;
  private stopping: Promise<void> | undefined;
  constructor(private readonly windowsJob?: WindowsJob) {}

  assign(pid: number): void {
    if (this.pid === pid) return;
    this.windowsJob?.assign(pid);
    this.pid = pid;
  }

  stop(): Promise<void> {
    return (this.stopping ??= this.stopOwnedTree());
  }

  private async stopOwnedTree(): Promise<void> {
    if (this.windowsJob) {
      this.windowsJob.terminate();
      while (this.windowsJob.activeProcesses() !== 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      this.windowsJob.close();
    } else if (this.pid !== undefined) {
      await stopProcessGroup(this.pid);
    }
  }
}

export async function createProjectProcessOwner(): Promise<ProjectProcessOwner> {
  const job =
    process.platform === "win32"
      ? (await import("../runner/windows-job.js")).createWindowsJob()
      : undefined;
  return new ProjectProcessOwner(job);
}
