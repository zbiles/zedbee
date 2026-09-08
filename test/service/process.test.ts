import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  acquireServiceExecutor,
  serviceStatus,
  stopService,
} from "../../dist/service/client.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await stopService({ directory: join(root, "s") });
    await rm(root, { recursive: true, force: true });
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
async function descendants(parent: number): Promise<number[]> {
  const run = promisify(execFile);
  const rows: Array<[number, number]> = [];
  if (process.platform === "win32") {
    const result = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    for (const row of JSON.parse(result.stdout))
      rows.push([row.ProcessId, row.ParentProcessId]);
  } else {
    const result = await run("/bin/ps", ["-axo", "pid=,ppid="], {
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of result.stdout.trim().split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      rows.push([pid!, ppid!]);
    }
  }
  const owned = new Set([parent]);
  let added = true;
  while (added) {
    added = false;
    for (const [pid, ppid] of rows)
      if (owned.has(ppid) && !owned.has(pid)) {
        owned.add(pid);
        added = true;
      }
  }
  owned.delete(parent);
  return [...owned].sort((a, b) => a - b);
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
  expect(before).toHaveLength(2);
  const second = await independentClient(config.directory);
  expect(second.status.pid).toBe(first.status.pid);
  expect(second.result).toBe("const a = 1;\n");
  expect(await descendants(first.status.pid)).toEqual(before);
  expect(await stopService(config)).toEqual({ state: "stopped" });
  for (const pid of before) expect(() => process.kill(pid, 0)).toThrow();
});
it("a killed caller retires its tree while an independent live client's session remains usable", async () => {
  const config = await options();
  const live = await acquireServiceExecutor(config);
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
    expect(await descendants(status.pid)).toHaveLength(2);
    await session.close();
  } finally {
    await live.close();
  }
});
it("service death with submitted analysis returns incomplete only after its real worker tree is gone", async () => {
  const config = await options();
  const executor = await acquireServiceExecutor(config);
  const session = await executor.openSession();
  // Warm a witnessed worker, then occupy it with real package-selected analysis.
  expect(await session.run(request)).toBe("const a = 1;\n");
  const status = await serviceStatus(config);
  if (status.state !== "running") throw new Error("Missing service");
  const owned = await descendants(status.pid);
  expect(owned).toHaveLength(2);
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
    const executor = await acquireServiceExecutor(config);
    const session = await executor.openSession();
    expect(await session.run(request)).toBe("const a = 1;\n");
    const status = await serviceStatus(config);
    expect(status.state).toBe("running");
    if (status.state !== "running") throw new Error("Missing service");
    const owned = await descendants(status.pid);
    expect(owned).toHaveLength(2);
    const supervisor = killSupervisor
      ? (
          await Promise.all(
            owned.map(async (pid) => ({
              pid,
              children: await descendants(pid),
            })),
          )
        ).find((row) => row.children.length > 0)?.pid
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
    const next = await acquireServiceExecutor(config);
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
  const [a, b] = await Promise.all([
    acquireServiceExecutor(config),
    acquireServiceExecutor(config),
  ]);
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
