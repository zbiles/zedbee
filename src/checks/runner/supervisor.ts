import {
  spawn,
  type ChildProcess,
  type Serializable,
} from "node:child_process";
import {
  workerExitedAbnormally,
  type ProcessExitStatus,
} from "./exit-status.js";

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
let windowsKillerClosed = false;
let windowsKillerExit: ProcessExitStatus | undefined;
let workerExit: ProcessExitStatus | undefined;
let windowsTerminationRequested = false;

function groupAlive(): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function signalGroup(signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    /* A reaped group is already stopped. */
  }
}
function complete(): void {
  if (finished) return;
  finished = true;
  // On Windows, include taskkill's outcome when interpreting observed exit1.
  // Do not decide before both exit outcomes are available.
  if (
    workerExit !== undefined &&
    workerExitedAbnormally(workerExit, {
      platform: process.platform,
      requested:
        process.platform === "win32" ? windowsTerminationRequested : stopping,
      ...(windowsKillerExit === undefined
        ? {}
        : { windowsKiller: windowsKillerExit }),
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
  if (process.connected)
    process.send?.(
      reply ?? { version: 1, ok: false, category: "invalid-response" },
      () => process.disconnect?.(),
    );
}
function forceWindows(): void {
  if (pid === undefined) {
    complete();
    return;
  }
  windowsTerminationRequested =
    !workerClosed && worker?.exitCode === null && worker.signalCode === null;
  // Keep the worker alive until taskkill enumerates /T, including native jscpd.
  const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.on("error", () => {
    reply = { version: 1, ok: false, category: "cleanup" };
    worker?.kill("SIGKILL");
  });
  killer.on("close", (code, signal) => {
    windowsKillerExit = { code, signal };
    windowsKillerClosed = true;
    if (workerClosed) complete();
  });
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
process.on("message", (message: unknown) => {
  const input = message as {
    type?: string;
    workerEntry?: string;
    execArgv?: string[];
    request?: unknown;
  };
  if (input.type === "cancel") {
    reply = { version: 1, ok: false, category: "cancellation" };
    stop(true);
    return;
  }
  if (
    worker ||
    stopping ||
    input.type !== "start" ||
    typeof input.workerEntry !== "string" ||
    !Array.isArray(input.execArgv)
  )
    return;
  worker = spawn(process.execPath, [...input.execArgv, input.workerEntry], {
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
  worker.on("message", (response) => {
    if (reply === undefined) reply = response;
    stop(false);
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
    if (process.platform === "win32" ? windowsKillerClosed : !groupAlive())
      complete();
  });
  worker.send(input.request as Serializable, (error) => {
    if (error && reply === undefined) {
      reply = { version: 1, ok: false, category: "startup" };
      stop(false);
    }
  });
});
