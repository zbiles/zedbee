import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { exactFields } from "../checks/runner/envelope.js";
import { ServiceUnavailableError } from "./protocol.js";
import type { ServiceIdentity } from "./identity.js";

export async function startCandidate(
  location: Pick<ServiceIdentity, "key" | "entry" | "directory">,
  pendingIdentity: Promise<ServiceIdentity>,
  concurrency: 1 | 2 | 4,
): Promise<"ready" | "busy"> {
  const execArgv = location.entry.endsWith(".ts")
    ? ["--import", import.meta.resolve("tsx")]
    : [];
  const child = spawn(process.execPath, [...execArgv, location.entry], {
    // The service outlives its initiating checkout; cwd is not source authority.
    cwd: dirname(location.entry),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    detached: true,
    windowsHide: true,
  });
  return new Promise<"ready" | "busy">((resolve, reject) => {
    let settling = false,
      startupSent = false,
      detaching = false;
    let witnessExit!: () => void;
    const exited = new Promise<void>((done) => {
      witnessExit = done;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disconnect = () => {
      if (child.connected) child.disconnect();
    };
    const fail = async () => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      disconnect();
      // A failed detach send may already have reached the child. SIGTERM keeps
      // its existing graceful cleanup path responsible even if it detached.
      if (detaching) child.kill("SIGTERM");
      await exited;
      child.unref();
      reject(new ServiceUnavailableError());
    };
    child.once("error", () => {
      // A spawn error has no process whose exit could witness cleanup.
      if (child.pid === undefined) witnessExit();
      void fail();
    });
    child.once("exit", () => {
      witnessExit();
      if (!settling) void fail();
    });
    child.on("message", (value) => {
      if (settling) return;
      if (!startupSent || detaching || !exactFields(value, ["type"])) {
        void fail();
        return;
      }
      if (value.type === "ready") {
        detaching = true;
        try {
          child.send({ type: "detach" }, (error) => {
            if (error) {
              void fail();
              return;
            }
            if (settling) return;
            settling = true;
            clearTimeout(timer);
            child.unref();
            disconnect();
            resolve("ready");
          });
        } catch {
          void fail();
        }
      } else if (value.type === "busy") {
        settling = true;
        clearTimeout(timer);
        disconnect();
        void exited.then(() => {
          child.unref();
          resolve("busy");
        });
      } else void fail();
    });
    void pendingIdentity
      .then((identity) => {
        if (settling) return;
        if (
          identity.key !== location.key ||
          identity.directory !== location.directory ||
          identity.entry !== location.entry
        ) {
          void fail();
          return;
        }
        // The caller's full identity is owned computation, not startup IPC.
        // Preserve the exchange bound only after that work and validation;
        // failure still awaits the candidate's cleanup and actual exit.
        timer = setTimeout(() => {
          void fail();
        }, 30000);
        startupSent = true;
        child.send(
          {
            directory: identity.directory,
            identity: identity.content,
            concurrency,
          },
          (error) => {
            if (error) void fail();
          },
        );
      })
      .catch(() => {
        void fail();
      });
  });
}
