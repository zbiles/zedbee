import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TelemetryStore } from "../../src/telemetry/state.js";
import { TelemetryDetailsStore } from "../../src/telemetry/details-store.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zedbee-telemetry-lease-"));
  roots.push(root);
  const directory = join(root, "telemetry");
  mkdirSync(directory, { mode: 0o700 });
  return { root, directory, store: new TelemetryStore(directory) };
}
const stateModule = new URL("../../src/telemetry/state.ts", import.meta.url)
  .href;
function child(directory: string, script: string) {
  const process = spawn(
    globalThis.process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { TelemetryStore } from ${JSON.stringify(stateModule)};
     import { randomUUID } from 'node:crypto';
     const directory = process.argv[1];
     const store = new TelemetryStore(directory);
     ${script}`,
      directory,
    ],
    { stdio: ["pipe", "pipe", "pipe", "ipc"] },
  );
  let stderr = "";
  process.stderr!.on("data", (data) => {
    stderr += String(data);
  });
  const exit = once(process, "exit").then(([code, signal]) => ({
    code,
    signal,
    stderr,
  }));
  const ready = Promise.race([
    once(process.stdout!, "data").then(([data]) => String(data)),
    exit.then((result) => {
      throw new Error(`Child exited before ready: ${JSON.stringify(result)}`);
    }),
  ]);
  return { process, exit, ready };
}
async function stop(process: ChildProcess) {
  if (process.exitCode === null && process.signalCode === null) {
    const exited = once(process, "exit");
    process.kill("SIGKILL");
    await exited;
  }
}
function legacy(
  directory: string,
  enabled: boolean,
  installation_id = randomUUID(),
) {
  const value = {
    version: 1,
    enabled,
    installation_id,
    notice_version: 1,
    events: [],
  };
  const temporary = join(directory, `${randomUUID()}.json`);
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, join(directory, "state.json"));
  return value;
}

it("leaves native bindings unloaded when only reading absent telemetry state", async () => {
  const { directory } = fixture();
  const reader = child(
    directory,
    `
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    if (store.read() !== undefined) throw new Error('unexpected state');
    if (Object.keys(require.cache).some(path => path.includes('/koffi/') || path.includes('\\\\koffi\\\\')))
      throw new Error('native bindings loaded before lock acquisition');
    process.stdout.write('cold');
    process.exit(0);
  `,
  );
  try {
    expect(await reader.ready).toBe("cold");
    expect((await reader.exit).code).toBe(0);
  } finally {
    await stop(reader.process);
  }
});

it.each(["state.lock", "sender.lock"] as const)(
  "releases %s after SIGKILL, excludes live owners, and preserves its inode",
  async (name) => {
    const { directory, store } = fixture();
    store.initialize();
    const owner = child(
      directory,
      `
    store.lock(${JSON.stringify(name)});
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `,
    );
    try {
      expect(await owner.ready).toBe("ready");
      const path = join(
        directory,
        name === "state.lock" ? "state-v2.lease" : "sender-v2.lease",
      );
      const before = lstatSync(path);
      utimesSync(path, new Date(0), new Date(0));
      expect(() => store.lock(name)).toThrow(/busy/u);
      if (name === "state.lock") {
        expect(() => store.setEnabled(false)).toThrow(/busy/u);
        expect(store.read()?.enabled).toBe(true);
      }
      await stop(owner.process);
      const release = store.lock(name);
      expect(() => store.lock(name)).toThrow(/busy/u);
      release();
      release();
      const after = lstatSync(path);
      expect([after.dev, after.ino, after.size]).toEqual([
        before.dev,
        before.ino,
        0,
      ]);
      store.setEnabled(false);
      expect(store.read()?.enabled).toBe(false);
    } finally {
      await stop(owner.process);
    }
  },
);

it("opts out after a real legacy reclaimer dies, without touching either orphan", async () => {
  const { directory, store } = fixture();
  const saved = legacy(directory, true);
  const owner = child(
    directory,
    `
    const { openSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const name of ['state.lock', 'sender.lock']) {
      writeFileSync(join(directory, name), String(process.pid), { mode: 0o600 });
      openSync(join(directory, name + '.reclaim'), 'wx', 0o600);
    }
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `,
  );
  try {
    await owner.ready;
    await stop(owner.process);
    store.setEnabled(false);
    expect(store.read()).toMatchObject({
      enabled: false,
      installation_id: saved.installation_id,
      events: [],
    });
    const release = store.lock("sender.lock");
    release();
    expect(
      JSON.parse(readFileSync(join(directory, "state.json"), "utf8")),
    ).toEqual(saved);
    for (const name of ["state.lock", "sender.lock"]) {
      expect(readFileSync(join(directory, name), "utf8")).toBe(
        String(owner.process.pid),
      );
      expect(existsSync(join(directory, `${name}.reclaim`))).toBe(true);
    }
  } finally {
    await stop(owner.process);
  }
});

it("isolates concurrent legacy writers, preserves opt-outs and explicitly acknowledges only the observed old preference", async () => {
  const { directory, store } = fixture();
  const saved = legacy(directory, false);
  const owner = child(
    directory,
    `
    const { openSync, closeSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const path = join(directory, 'state.lock');
    const fd = openSync(path, 'wx', 0o600);
    process.stdout.write('ready');
    process.once('message', () => { closeSync(fd); unlinkSync(path); process.exit(0); });
  `,
  );
  try {
    await owner.ready;
    expect(store.initialize()).toMatchObject({
      enabled: false,
      installation_id: saved.installation_id,
    });
    store.setEnabled(true);
    expect(store.read()?.enabled).toBe(true);
    const lease = lstatSync(join(directory, "state-v2.lease"));
    owner.process.send("release");
    expect((await owner.exit).code).toBe(0);
    const after = lstatSync(join(directory, "state-v2.lease"));
    expect([after.dev, after.ino]).toEqual([lease.dev, lease.ino]);
    // Rewriting the same disabled bytes is a fresh opt-out, even without a content change.
    legacy(directory, false, saved.installation_id);
    expect(store.read()?.enabled).toBe(false);
    store.initialize();
    legacy(directory, true, saved.installation_id);
    expect(store.read()?.enabled).toBe(false);
    store.setEnabled(true);
    expect(store.read()?.enabled).toBe(true);
    store.setEnabled(false);
    legacy(directory, true, saved.installation_id);
    expect(store.read()?.enabled).toBe(false);
  } finally {
    await stop(owner.process);
  }
});

it("preserves every successful update from concurrent different processes", async () => {
  const { directory, store } = fixture();
  const id = store.initialize().installation_id;
  const workers = Array.from({ length: 3 }, () =>
    child(
      directory,
      `
    process.stdout.write('ready');
    await new Promise(resolve => process.once('message', resolve));
    for (let index = 0; index < 20; index++) {
      const event = {
        schema_version: 1, event: 'scan_started', event_id: randomUUID(), run_id: randomUUID(),
        timestamp: new Date().toISOString(), version: '0.1.0', os: 'linux', arch: 'x64',
        node_major: 24, command: 'scan', environment: 'ci_not_detected',
        invocation_source: 'unspecified', installation_id: ${JSON.stringify(id)}, scan_mode: 'staged',
      };
      for (;;) {
        try { store.enqueue(event); break; }
        catch (error) {
          if (error.code !== 'EBUSY') throw error;
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }
    }
    process.exit(0);
  `,
    ),
  );
  try {
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.process.send("go");
    for (const result of await Promise.all(
      workers.map((worker) => worker.exit),
    ))
      expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(store.pending()).toHaveLength(60);
    expect(new Set(store.pending().map((event) => event.event_id)).size).toBe(
      60,
    );
  } finally {
    await Promise.all(workers.map((worker) => stop(worker.process)));
  }
});

it("isolates detail pruning from both generations' queues", () => {
  const { directory } = fixture();
  const oldDirectory = join(directory, "details");
  mkdirSync(oldDirectory, { mode: 0o700 });
  const oldPath = join(oldDirectory, `${randomUUID()}.json`);
  writeFileSync(oldPath, "old sidecar", { mode: 0o600 });
  utimesSync(oldPath, new Date(0), new Date(0));
  const details = new TelemetryDetailsStore(directory);
  details.clear();
  details.prune([]);
  expect(readFileSync(oldPath, "utf8")).toBe("old sidecar");
  expect(details.path).toBe(join(directory, "details-v2"));
});

it("rejects corrupt current state without replacing it or resetting the saved preference", () => {
  const { directory, store } = fixture();
  store.setEnabled(false);
  const path = join(directory, "state-v2.json");
  writeFileSync(path, "corrupt");
  expect(() => store.initialize()).toThrow();
  expect(() => store.setEnabled(true)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("corrupt");
});

it.skipIf(process.platform === "win32")(
  "rejects hostile lease links, permissions, owners and directories without changing targets",
  () => {
    const { root, directory, store } = fixture();
    const path = join(directory, "state-v2.lease");
    const target = join(root, "target");
    writeFileSync(target, "", { mode: 0o600 });
    for (const makeLink of [symlinkSync, linkSync]) {
      makeLink(target, path);
      expect(() => store.setEnabled(false)).toThrow();
      expect(readFileSync(target, "utf8")).toBe("");
      rmSync(path);
    }
    writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => store.setEnabled(false)).toThrow(/permissions/u);
    chmodSync(path, 0o600);
    vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    expect(() => store.setEnabled(false)).toThrow(/permissions/u);
    vi.restoreAllMocks();
    rmSync(path);
    mkdirSync(path, { mode: 0o700 });
    expect(() => store.setEnabled(false)).toThrow();
    rmSync(path, { recursive: true });
    writeFileSync(path, "untrusted", { mode: 0o600 });
    expect(() => store.setEnabled(false)).toThrow(/lease/u);
    expect(readFileSync(path, "utf8")).toBe("untrusted");
    rmSync(directory, { recursive: true });
    const actual = join(root, "actual");
    mkdirSync(actual, { mode: 0o700 });
    symlinkSync(actual, directory);
    expect(() => store.setEnabled(false)).toThrow(/Unsafe telemetry/u);
    expect(existsSync(join(actual, "state-v2.json"))).toBe(false);
  },
);
