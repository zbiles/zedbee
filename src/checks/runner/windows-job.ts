import koffi from "koffi";
import { WINDOWS_JOB_TERMINATION_EXIT_CODE } from "./exit-status.js";
import { createOwnedWindowsJobHandle } from "../../service/windows-pipe.js";

// This module is dynamically loaded only on Windows. Handles are unnamed and
// noninheritable: neither a worker nor its native CLI descendants can keep the
// owner's last handle alive. No breakaway flags are enabled.
const kernel = koffi.load("kernel32.dll");
const basicLimits = koffi.struct({
  PerProcessUserTimeLimit: "int64",
  PerJobUserTimeLimit: "int64",
  LimitFlags: "uint32",
  MinimumWorkingSetSize: "size_t",
  MaximumWorkingSetSize: "size_t",
  ActiveProcessLimit: "uint32",
  Affinity: "uintptr_t",
  PriorityClass: "uint32",
  SchedulingClass: "uint32",
});
const extendedLimits = koffi.struct({
  BasicLimitInformation: basicLimits,
  IoInfo: koffi.array("uint64", 6),
  ProcessMemoryLimit: "size_t",
  JobMemoryLimit: "size_t",
  PeakProcessMemoryUsed: "size_t",
  PeakJobMemoryUsed: "size_t",
});
const accounting = koffi.struct({
  TotalUserTime: "int64",
  TotalKernelTime: "int64",
  ThisPeriodTotalUserTime: "int64",
  ThisPeriodTotalKernelTime: "int64",
  TotalPageFaultCount: "uint32",
  TotalProcesses: "uint32",
  ActiveProcesses: "uint32",
  TotalTerminatedProcesses: "uint32",
});
const create = kernel.func(
  "void * __stdcall CreateJobObjectW(void *attributes, const char16_t *name)",
);
const setInformation = kernel.func(
  "int __stdcall SetInformationJobObject(void *job, int kind, void *information, uint32_t size)",
);
const queryInformation = kernel.func(
  "__stdcall",
  "QueryInformationJobObject",
  "int",
  ["void *", "int", koffi.out(koffi.pointer(accounting)), "uint32", "void *"],
);
const openProcess = kernel.func(
  "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
);
const assign = kernel.func(
  "int __stdcall AssignProcessToJobObject(void *job, void *process)",
);
const terminate = kernel.func(
  "int __stdcall TerminateJobObject(void *job, uint32_t exitCode)",
);
const closeHandle = kernel.func("int __stdcall CloseHandle(void *handle)");

export interface WindowsJob {
  assign(pid: number): void;
  terminate(): void;
  activeProcesses(): number;
  close(): void;
}

export function createWindowsJob(capabilityName?: string): WindowsJob {
  const handle = capabilityName
    ? createOwnedWindowsJobHandle(capabilityName)
    : create(null, null);
  if (!handle) throw new Error("Windows job creation failed");
  let closed = false;
  const close = () => {
    if (closed) return;
    if (!closeHandle(handle)) throw new Error("Windows job close failed");
    closed = true;
  };
  // The only enabled limit is KILL_ON_JOB_CLOSE (0x2000). Zero all reserved
  // fields; Koffi determines the native structure's pointer-sized ABI layout.
  const limits = Buffer.alloc(koffi.sizeof(extendedLimits));
  limits.writeUInt32LE(0x2000, koffi.offsetof(basicLimits, "LimitFlags"));
  if (!setInformation(handle, 9, limits, limits.length)) {
    close();
    throw new Error("Windows job configuration failed");
  }
  return {
    assign(pid) {
      if (closed) throw new Error("Windows job is closed");
      // AssignProcessToJobObject requires PROCESS_SET_QUOTA | PROCESS_TERMINATE.
      const child = openProcess(0x100 | 0x1, 0, pid);
      if (!child) throw new Error("Windows process open failed");
      try {
        if (!assign(handle, child))
          throw new Error("Windows job assignment failed");
      } finally {
        closeHandle(child);
      }
    },
    terminate() {
      if (closed || !terminate(handle, WINDOWS_JOB_TERMINATION_EXIT_CODE))
        throw new Error("Windows job termination failed");
    },
    activeProcesses() {
      if (closed) throw new Error("Windows job is closed");
      const state = { ActiveProcesses: 0 };
      if (!queryInformation(handle, 1, state, koffi.sizeof(accounting), null))
        throw new Error("Windows job accounting failed");
      return state.ActiveProcesses;
    },
    close,
  };
}

/** Keep the owning handle until the OS accounts for every descendant's exit. */
export async function stopWindowsJob(job: WindowsJob): Promise<void> {
  job.terminate();
  while (job.activeProcesses() !== 0)
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  job.close();
}
