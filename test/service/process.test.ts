import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  acquireServiceExecutor,
  serviceStatus,
  stopService,
} from "../../dist/service/client.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";
import { removeServiceFixture } from "./fixture-cleanup.js";
const roots: string[] = [];
const clients: Array<() => Promise<void>> = [];
async function acquire(config: Parameters<typeof acquireServiceExecutor>[0]) {
  const executor = await acquireServiceExecutor(config);
  clients.push(() => executor.close());
  return executor;
}
afterEach(async () => {
  // Always close client-owned lease/Job handles, including failed assertions.
  // Service-loss close may reject after proving cleanup; all closers still run.
  await Promise.allSettled(clients.splice(0).map((close) => close()));
  for (const root of roots.splice(0)) {
    await removeServiceFixture(
      root,
      await stopService({ directory: join(root, "s") }),
    );
  }
});
async function options() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zp-")));
  roots.push(root);
  return { directory: join(root, "s") };
}
const request = {
  version: 1,
  checkId: "formatting",
  operation: "format-working-source",
  input: {
    file: "a.js",
    source: "const a=1",
    settings: DEFAULT_FORMATTING_SETTINGS,
  },
} as const;
async function observeTree(parent: number) {
  const run = promisify(execFile);
  const rows: Array<{
    pid: number;
    parent: number;
    command: string;
    executable?: string;
  }> = [];
  if (process.platform === "win32") {
    const result = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    for (const row of JSON.parse(result.stdout))
      rows.push({
        pid: row.ProcessId,
        parent: row.ParentProcessId,
        command: row.CommandLine ?? "",
        executable: row.ExecutablePath ?? "",
      });
  } else {
    const result = await run("/bin/ps", ["-axo", "pid=,ppid=,args="], {
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of result.stdout.trim().split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      if (match)
        rows.push({
          pid: Number(match[1]),
          parent: Number(match[2]),
          command: match[3]!,
        });
    }
  }
  const owned = new Set([parent]);
  let added = true;
  while (added) {
    added = false;
    for (const { pid, parent: ppid } of rows)
      if (owned.has(ppid) && !owned.has(pid)) {
        owned.add(pid);
        added = true;
      }
  }
  owned.delete(parent);
  return rows.filter((row) => owned.has(row.pid)).sort((a, b) => a.pid - b.pid);
}
async function descendants(parent: number): Promise<number[]> {
  return (await observeTree(parent)).map((row) => row.pid);
}
async function engineProcesses(parent: number) {
  const rows = await observeTree(parent);
  const engines = rows.flatMap((row) => {
    const role =
      /[\\/]checks[\\/]runner[\\/](supervisor|bootstrap)\.js(?:["\s]|$)/u.exec(
        row.command,
      )?.[1];
    if (!role) return [];
    if (process.platform === "win32")
      expect(row.executable?.replaceAll("\\", "/").toLowerCase()).toBe(
        process.execPath.replaceAll("\\", "/").toLowerCase(),
      );
    return [{ pid: row.pid, role }];
  });
  expect(engines.map((row) => row.role).sort()).toEqual([
    "bootstrap",
    "supervisor",
  ]);
  return engines;
}
async function independentClient(
  directory: string,
): Promise<{ result: string; status: { pid: number } }> {
  const module = new URL("../../dist/service/client.js", import.meta.url).href;
  const code = `import {acquireServiceExecutor,serviceStatus} from ${JSON.stringify(module)}; const options={directory:process.argv[1]}; const executor=await acquireServiceExecutor(options); try {const session=await executor.openSession(); const result=await session.run(${JSON.stringify(request)}); await session.close(); console.log(JSON.stringify({result,status:await serviceStatus(options)}));} finally {await executor.close();}`;
  const result = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", code, directory],
    { maxBuffer: 1024 * 1024 },
  );
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}
it("status and stop do not create state or start a process", async () => {
  const config = await options();
  expect(await serviceStatus(config)).toEqual({ state: "stopped" });
  expect(await stopService(config)).toEqual({ state: "stopped" });
  await expect(lstat(config.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("independent command processes reuse a real worker and stop releases that entire tree", async () => {
  const config = await options();
  const first = await independentClient(config.directory);
  expect(first.result).toBe("const a = 1;\n");
  const before = await descendants(first.status.pid);
  const engines = await engineProcesses(first.status.pid);
  const second = await independentClient(config.directory);
  expect(second.status.pid).toBe(first.status.pid);
  expect(second.result).toBe("const a = 1;\n");
  expect(await descendants(first.status.pid)).toEqual(before);
  expect(await engineProcesses(first.status.pid)).toEqual(engines);
  expect(await stopService(config)).toEqual({ state: "stopped" });
  for (const pid of before) expect(() => process.kill(pid, 0)).toThrow();
});
it("a killed caller retires its tree while an independent live client's session remains usable", async () => {
  const config = await options();
  const live = await acquire(config);
  try {
    const session = await live.openSession();
    expect(await session.run(request)).toBe("const a = 1;\n");
    const module = new URL("../../dist/service/client.js", import.meta.url)
      .href;
    const code = `import {acquireServiceExecutor} from ${JSON.stringify(module)}; const executor=await acquireServiceExecutor({directory:process.argv[1]}); const session=await executor.openSession(); await session.run(${JSON.stringify(request)}); process.stdout.write("ready\\n",()=>process.kill(process.pid,"SIGKILL"));`;
    await expect(
      promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", code, config.directory],
        { maxBuffer: 1024 * 1024 },
      ),
      // Windows TerminateProcess and POSIX signals encode the exit differently;
      // the marker proves analysis finished before the deliberate abrupt exit.
    ).rejects.toMatchObject({ stdout: "ready\n", stderr: "" });
    await expect
      .poll(() => serviceStatus(config))
      .toMatchObject({ state: "running", activeSessions: 1 });
    expect(await session.run(request)).toBe("const a = 1;\n");
    const status = await serviceStatus(config);
    if (status.state !== "running") throw new Error("Missing service");
    await engineProcesses(status.pid);
    await session.close();
  } finally {
    await live.close();
  }
});
it("service death with submitted analysis returns incomplete only after its real worker tree is gone", async () => {
  const config = await options();
  const executor = await acquire(config);
  const session = await executor.openSession();
  // Warm a witnessed worker, then occupy it with real package-selected analysis.
  expect(await session.run(request)).toBe("const a = 1;\n");
  const status = await serviceStatus(config);
  if (status.state !== "running") throw new Error("Missing service");
  const owned = await descendants(status.pid);
  await engineProcesses(status.pid);
  let settled = false;
  const job = session
    .run({
      ...request,
      input: { ...request.input, source: "a();\n".repeat(200000) },
    })
    .finally(() => {
      settled = true;
    });
  const failure = expect(job).rejects.toMatchObject({
    diagnostic: { category: "abnormal-exit" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  process.kill(status.pid, "SIGKILL");
  await failure;
  for (const pid of owned) expect(() => process.kill(pid, 0)).toThrow();
  await executor.close().catch(() => {});
});
it.each([false, true])(
  "service death (also kill supervisor: %s) leaves close pending until all independently witnessed workers are gone and permits stale-state recovery",
  async (killSupervisor) => {
    const config = await options();
    const executor = await acquire(config);
    const session = await executor.openSession();
    expect(await session.run(request)).toBe("const a = 1;\n");
    const status = await serviceStatus(config);
    expect(status.state).toBe("running");
    if (status.state !== "running") throw new Error("Missing service");
    const owned = await descendants(status.pid);
    const engines = await engineProcesses(status.pid);
    const supervisor = killSupervisor
      ? engines.find((row) => row.role === "supervisor")?.pid
      : undefined;
    if (killSupervisor) expect(supervisor).toBeDefined();
    process.kill(status.pid, "SIGKILL");
    if (supervisor) {
      try {
        process.kill(supervisor, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await session.close().catch(() => {});
    await executor.close().catch(() => {});
    for (const pid of owned) expect(() => process.kill(pid, 0)).toThrow();
    const next = await acquire(config);
    try {
      const fresh = await next.openSession();
      expect(await fresh.run(request)).toBe("const a = 1;\n");
      await fresh.close();
    } finally {
      await next.close();
    }
  },
);
it("concurrent startup shares one owned service and concurrency mismatch rejects before work", async () => {
  const config = await options();
  const [a, b] = await Promise.all([acquire(config), acquire(config)]);
  try {
    const sa = await a.openSession(),
      sb = await b.openSession();
    expect(await sa.run(request)).toBe("const a = 1;\n");
    expect(await sb.run(request)).toBe("const a = 1;\n");
    expect(await serviceStatus(config)).toMatchObject({
      state: "running",
      activeSessions: 2,
      concurrency: 2,
    });
    await expect(
      acquireServiceExecutor({ ...config, concurrency: 4 }),
    ).rejects.toThrow();
    await sa.close();
    await sb.close();
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
  const status = await serviceStatus(config);
  expect(status.state).toBe("running");
  expect(await stopService(config)).toEqual({ state: "stopped" });
  if (status.state === "running")
    await expect
      .poll(() => {
        try {
          process.kill(status.pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
});
