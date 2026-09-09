import {
  spawn,
  type ChildProcess,
  type Serializable,
} from "node:child_process";
import {
  workerExitedAbnormally,
  type ProcessExitStatus,
} from "./exit-status.js";
import { fileURLToPath } from "node:url";
import type { WindowsJob } from "./windows-job.js";
import {
  processGroupAlive,
  processGroupHasDescendants,
  signalProcessGroup,
} from "./process-group.js";

// This process must remain engine-free and responsive even when its worker is
// synchronously blocked. The parent owns it until its complete process tree stops.
const GRACE_MS = 2_000;
let worker: ChildProcess | undefined;
let pid: number | undefined;
let finished = false;
let stopping = false;
let reply: unknown;
let timer: NodeJS.Timeout | undefined;
let poll: NodeJS.Timeout | undefined;
let workerClosed = false;
let windowsJob: WindowsJob | undefined;
let workerExit: ProcessExitStatus | undefined;
let windowsTerminationRequested = false;
let posixTerminationRequested = false;
let releaseWorker: (() => void) | undefined;

function groupAlive(): boolean {
  return pid !== undefined && processGroupAlive(pid);
}
function signalGroup(signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  if (!workerClosed) posixTerminationRequested = true;
  signalProcessGroup(pid, signal);
}
function complete(): void {
  if (finished) return;
  finished = true;
  if (
    workerExit !== undefined &&
    workerExitedAbnormally(workerExit, {
      platform: process.platform,
      requested:
        process.platform === "win32"
          ? windowsTerminationRequested
          : posixTerminationRequested,
    })
  ) {
    reply = {
      version: 1,
      ok: false,
      category: "abnormal-exit",
      ...(workerExit.code === null ? {} : { exitCode: workerExit.code }),
      ...(workerExit.signal === null ? {} : { signal: workerExit.signal }),
    };
  }
  if (timer) clearTimeout(timer);
  if (poll) clearInterval(poll);
  try {
    windowsJob?.close();
  } catch {
    reply = { version: 1, ok: false, category: "cleanup" };
  }
  if (process.connected)
    process.send?.(
      {
        type: "result",
        response: reply ?? {
          version: 1,
          ok: false,
          category: "invalid-response",
        },
      } as Serializable,
      () => process.disconnect?.(),
    );
}
function forceWindows(): void {
  try {
    windowsJob?.terminate();
    windowsTerminationRequested = true;
    checkWindowsStopped();
  } catch {
    reply = { version: 1, ok: false, category: "cleanup" };
    // The parent owns an outer Job Object and confirms its empty state even
    // when this supervisor fails; closing our last handle also kills the tree.
    complete();
  }
}
function checkWindowsStopped(): void {
  try {
    if (workerClosed && (windowsJob?.activeProcesses() ?? 0) === 0) complete();
  } catch {
    reply = { version: 1, ok: false, category: "cleanup" };
    complete();
  }
}
function stop(cancelled: boolean): void {
  if (stopping) return;
  stopping = true;
  if (!worker || pid === undefined) {
    complete();
    return;
  }
  if (cancelled && worker.connected) worker.send({ type: "cancel" }, () => {});
  if (process.platform === "win32") {
    poll = setInterval(checkWindowsStopped, 20);
    if (cancelled) timer = setTimeout(forceWindows, GRACE_MS);
    else forceWindows();
    return;
  }
  // SIGTERM on completion discards the worker and any surviving descendants;
  // cancellation first permits managed child cleanup through AbortSignal.
  if (!cancelled) signalGroup("SIGTERM");
  timer = setTimeout(() => signalGroup("SIGKILL"), GRACE_MS);
  poll = setInterval(() => {
    if (workerClosed && !groupAlive()) complete();
  }, 20);
}
const cancel = () => {
  reply = { version: 1, ok: false, category: "cancellation" };
  stop(true);
};
process.on("disconnect", cancel);
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
process.on("SIGHUP", cancel);
if (process.platform === "win32") process.on("SIGBREAK", cancel);
// Caller may have died while Node or its source loader was starting.
if (!process.connected) process.exit(0);
let starting = false;
process.on("message", async (message: unknown) => {
  const input = message as {
    type?: string;
    workerEntry?: string;
    execArgv?: string[];
    request?: unknown;
  };
  if (input.type === "job" || input.type === "release") {
    if (!worker || !worker.connected || stopping) {
      reply = { version: 1, ok: false, category: "invalid-response" };
      stop(false);
    } else worker.send(message as Serializable, () => {});
    return;
  }
  if (input.type === "stop") {
    stop(false);
    return;
  }
  if (input.type === "ownership-ack") {
    if (!stopping) releaseWorker?.();
    releaseWorker = undefined;
    return;
  }
  if (input.type === "cancel") {
    reply = { version: 1, ok: false, category: "cancellation" };
    stop(true);
    return;
  }
  if (
    worker ||
    starting ||
    stopping ||
    input.type !== "start" ||
    typeof input.workerEntry !== "string" ||
    !Array.isArray(input.execArgv)
  )
    return;
  starting = true;
  if (process.platform === "win32") {
    try {
      const { createWindowsJob } = await import("./windows-job.js");
      if (stopping) return;
      windowsJob = createWindowsJob();
    } catch {
      reply = { version: 1, ok: false, category: "startup" };
      complete();
      return;
    }
  }
  const bootstrap = fileURLToPath(
    new URL(
      `./bootstrap.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
      import.meta.url,
    ),
  );
  worker = spawn(process.execPath, [...input.execArgv, bootstrap], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    detached: process.platform !== "win32",
    windowsHide: true,
    serialization: "advanced",
  });
  pid = worker.pid;
  worker.on("error", () => {
    reply = { version: 1, ok: false, category: "startup" };
    stop(false);
  });
  let owned = false;
  worker.on("message", async (response) => {
    if (
      !owned &&
      (response as { type?: string })?.type === "ready-for-ownership"
    ) {
      if (stopping) return;
      try {
        if (pid === undefined) throw new Error("Missing worker PID");
        windowsJob?.assign(pid);
        owned = true;
        releaseWorker = () => {
          const request = input.request;
          input.request = undefined;
          worker!.send(
            {
              type: "owned-start",
              workerEntry: input.workerEntry,
              request,
            } as Serializable,
            (error) => {
              if (error && reply === undefined) {
                reply = { version: 1, ok: false, category: "startup" };
                stop(false);
              }
            },
          );
        };
        // Do not release engine code until the caller has retained this group
        // identity. The envelope cannot be forged by a worker response.
        process.send?.({ type: "worker-owned", pid });
      } catch {
        reply = { version: 1, ok: false, category: "startup" };
        // Assignment failed before any engine code could execute.
        worker!.kill("SIGKILL");
        stop(false);
      }
      return;
    }
    if ((response as { type?: unknown })?.type === "released") {
      // A reset acknowledgement cannot release snapshots while an inherited
      // native CLI descendant is still alive. Retire the complete owned tree.
      let retire = true;
      try {
        retire =
          process.platform === "win32"
            ? (windowsJob?.activeProcesses() ?? 2) > 1
            : await processGroupHasDescendants(pid!);
      } catch {
        /* Missing inventory evidence permits retirement, never reuse. */
      }
      if (retire) response = { ...(response as object), retire: true };
    }
    // Results are provisional; the executor validates matching result/ready
    // messages. Only cleanup completion below can settle a retired tree.
    process.send?.({
      type: "worker-message",
      message: response,
    } as Serializable);
  });
  worker.on("close", (exitCode, signal) => {
    workerClosed = true;
    workerExit = { code: exitCode, signal };
    if (reply === undefined)
      reply = {
        version: 1,
        ok: false,
        category: exitCode === 0 ? "invalid-response" : "abnormal-exit",
        ...(exitCode === null ? {} : { exitCode }),
        ...(signal === null ? {} : { signal }),
      };
    if (!stopping) stop(false);
    if (process.platform === "win32") checkWindowsStopped();
    else if (!groupAlive()) complete();
  });
});
