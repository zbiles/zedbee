import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { stopProcessGroup } from "../../../src/checks/runner/process-group.js";
import { waitForAssertion } from "../../helpers/wait-for-assertion.js";

it.skipIf(process.platform !== "darwin")(
  "waits for an independently retained zombie group to be reaped after macOS EPERM",
  async () => {
    // Stop the reaper before killing its detached child. This keeps a real
    // zombie group present until the test explicitly permits waitpid to run.
    const reaper = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.once('message', () => process.send({ pid: child.pid }));
      child.once('close', () => process.disconnect());
    `,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const exited = once(reaper, "exit");
    let pgid: number | undefined;
    let stopped: Promise<void> | undefined;
    const rows = async () =>
      (await promisify(execFile)("/bin/ps", ["-axo", "pid=,stat="])).stdout;
    const state = async (pid: number) =>
      (await rows())
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .find(([value]) => Number(value) === pid)?.[1];
    try {
      const [message] = await Promise.race([once(reaper, "message"), exited]);
      pgid = (message as { pid: number }).pid;
      expect(pgid).toBeGreaterThan(0);
      process.kill(reaper.pid!, "SIGSTOP");
      await waitForAssertion(async () =>
        expect(await state(reaper.pid!)).toMatch(/^T/u),
      );
      process.kill(pgid, "SIGKILL");
      await waitForAssertion(async () =>
        expect(await state(pgid!)).toMatch(/^Z/u),
      );
      expect(() => process.kill(-pgid!, 0)).toThrow(
        expect.objectContaining({ code: "EPERM" }),
      );
      let outcome = "pending";
      stopped = stopProcessGroup(pgid).then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toBe("pending");
      process.kill(reaper.pid!, "SIGCONT");
      await exited;
      await stopped;
      expect(outcome).toBe("resolved");
      expect(() => process.kill(-pgid!, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    } finally {
      if (pgid !== undefined) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {}
      }
      if (reaper.exitCode === null && reaper.signalCode === null)
        process.kill(reaper.pid!, "SIGCONT");
      await exited;
      await stopped;
    }
  },
);
