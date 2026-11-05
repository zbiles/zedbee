import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  unlink,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTemporaryReportStore } from "../../src/reporting/temporary-reports.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("recovers after a killed lock owner, preserves live ownership, and expires tracked reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "zedbee-report-lock-"));
  roots.push(root);
  const repositoryRoot = join(root, "repository");
  await mkdir(repositoryRoot);
  let now = 1_700_000_000_000;
  const store = createTemporaryReportStore({
    temporaryRoot: root,
    now: () => now,
  });
  const initial = await store.maintain({
    repositoryRoot,
    maxAgeMs: 1_000,
    json: "old",
  });
  expect(initial.reportPath).toBeDefined();
  const directory = dirname(initial.reportPath!);
  const lockPath = join(directory, ".lifecycle.lock");
  // This also recreates the exact empty lock left by the previous wx protocol.
  await writeFile(lockPath, "", { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { open } from 'node:fs/promises';
    let lease;
    if (process.platform === 'win32') {
      const native = await import(${JSON.stringify(new URL("../../src/service/windows-pipe.ts", import.meta.url).href)});
      lease = native.openWindowsStateLease(process.argv[1]);
    } else {
      const file = await open(process.argv[1], 'r+');
      const koffi = (await import('koffi')).default;
      const flock = koffi.load(null).func('int flock(int fd, int operation)');
      lease = { acquire: () => flock(file.fd, 2 | 4) === 0 };
    }
    if (!lease.acquire()) throw new Error('owner could not acquire lock');
    process.stdout.write('locked\\n');
    setInterval(() => {}, 1000);
  `,
      lockPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    const ready = await Promise.race([
      once(child.stdout, "data").then(([chunk]) => String(chunk)),
      exited.then(() => {
        throw new Error(`Lock owner exited: ${stderr}`);
      }),
    ]);
    expect(ready).toBe("locked\n");
    const identity = await lstat(lockPath);
    // An ancient mtime must never allow a live owner to be stolen.
    await utimes(lockPath, 1, 1);
    now += 2_000;
    const blocked = await Promise.all(
      [1, 2].map(() =>
        store.maintain({ repositoryRoot, maxAgeMs: 1_000, json: "blocked" }),
      ),
    );
    expect(blocked.every((value) => value.reportPath === undefined)).toBe(true);
    expect(
      blocked.every((value) =>
        value.warnings.some(
          (warning) => warning.code === "TEMP_REPORT_CLEANUP_FAILED",
        ),
      ),
    ).toBe(true);
    await expect(readFile(initial.reportPath!, "utf8")).resolves.toBe("old");
    child.kill("SIGKILL");
    await exited;
    const recovered = await Promise.all(
      ["first", "second"].map((json) =>
        store.maintain({ repositoryRoot, maxAgeMs: 1_000, json }),
      ),
    );
    expect(recovered.map((value) => value.warnings)).toEqual([[], []]);
    expect(new Set(recovered.map((value) => value.reportPath)).size).toBe(2);
    for (const value of recovered) expect(value.reportPath).toBeDefined();
    await expect(lstat(initial.reportPath!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const after = await lstat(lockPath);
    expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
    const state = JSON.parse(
      await readFile(join(directory, ".lifecycle.json"), "utf8"),
    );
    expect(state.reports).toHaveLength(2);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
});

it("isolates legacy exclusive-file writers and leaves their reports and state untouched", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zedbee-report-protocol-")),
  );
  roots.push(root);
  const repositoryRoot = join(root, "repository");
  await mkdir(repositoryRoot);
  const legacyHash = createHash("sha256")
    .update(await realpath(repositoryRoot), "utf8")
    .digest("hex")
    .slice(0, 32);
  const legacyDirectory = join(root, "zedbee-u1234", legacyHash);
  await mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
  const legacyLockPath = join(legacyDirectory, ".lifecycle.lock");
  // A live older CLI owns this wx handle but does not participate in flock.
  const legacyLock = await open(legacyLockPath, "wx", 0o600);
  const legacyReport = join(
    legacyDirectory,
    "zedbee-scan-report-20200101000000.json",
  );
  const legacyStatePath = join(legacyDirectory, ".lifecycle.json");
  const legacyState = JSON.stringify({
    schemaVersion: 2,
    reports: [
      { fileName: "zedbee-scan-report-20200101000000.json", createdAtMs: 0 },
    ],
  });
  await writeFile(legacyReport, "legacy report");
  await writeFile(legacyStatePath, legacyState);
  const store = createTemporaryReportStore({
    temporaryRoot: root,
    userIdentity: { uid: 1234, username: "fixture" },
  });
  try {
    const maintained = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
      json: "new report",
    });
    expect(maintained.warnings).toEqual([]);
    expect(maintained.reportPath).toBeDefined();
    expect(dirname(maintained.reportPath!)).not.toBe(legacyDirectory);
    await expect(readFile(legacyReport, "utf8")).resolves.toBe("legacy report");
    await expect(readFile(legacyStatePath, "utf8")).resolves.toBe(legacyState);
    await expect(readFile(legacyLockPath, "utf8")).resolves.toBe("");
    const currentLockPath = join(
      dirname(maintained.reportPath!),
      ".lifecycle.lock",
    );
    const before = await lstat(currentLockPath);
    // Normal old-version release must not unlink the current protocol's inode.
    await legacyLock.close();
    await unlink(legacyLockPath);
    const after = await lstat(currentLockPath);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  } finally {
    await legacyLock.close();
  }
});
