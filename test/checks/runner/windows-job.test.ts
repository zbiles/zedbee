import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")(
  "retains ownership of detached descendants and new grandchildren after the leader exits",
  async () => {
    const { createWindowsJob, stopWindowsJob } =
      await import("../../../src/checks/runner/windows-job.js");
    const job = createWindowsJob();
    const root = await mkdtemp(join(tmpdir(), "zedbee-native-job-"));
    const release = join(root, "release");
    const pidsFile = join(root, "pids.json");
    // The leader waits for assignment; its detached child stays alive after the
    // leader exits and later creates a grandchild, outside libuv's own job tree.
    const descendantCode = `
    const {spawn}=require('node:child_process');
    const {existsSync,writeFileSync}=require('node:fs');
    writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify([process.pid]));
    const poll=setInterval(() => {
      if (!existsSync(${JSON.stringify(release)})) return;
      clearInterval(poll);
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'});
      writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify([process.pid,child.pid]));
    }, 20);
    setInterval(()=>{},1000);
    process.send('ready');
  `;
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `
    process.once('message', () => {
      const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>process.exit(7));
    });
  `,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const exited = once(leader, "exit");
    try {
      job.assign(leader.pid!);
      leader.send("start");
      expect(await exited).toEqual([7, null]);
      await writeFile(release, "leader has exited");
      await expect
        .poll(() => job.activeProcesses(), { timeout: 10000 })
        .toBe(2);
      job.terminate();
      await expect
        .poll(() => job.activeProcesses(), { timeout: 10000 })
        .toBe(0);
    } finally {
      await stopWindowsJob(job);
      if (leader.exitCode === null) leader.kill("SIGKILL");
      // Also clean exact fixture descendants if ownership itself regresses.
      const pids: number[] = await readFile(pidsFile, "utf8")
        .then(JSON.parse)
        .catch(() => []);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
