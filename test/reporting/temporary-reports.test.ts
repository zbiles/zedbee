import { waitForAssertion } from "../helpers/wait-for-assertion.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createTemporaryReportStore,
  syncTemporaryReportDirectory,
} from "../../src/reporting/temporary-reports.js";

const uuidControl = vi.hoisted(() => ({ values: [] as string[] }));
const filesystemControl = vi.hoisted(() => ({
  lstatFailures: new Map<string, string>(),
  openFailures: new Map<string, string>(),
  rejectNumericDirectoryOpen: false,
}));

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return {
    ...original,
    randomUUID: () => uuidControl.values.shift() ?? original.randomUUID(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    async open(...args: Parameters<typeof original.open>) {
      const key = String(args[0]);
      if (
        filesystemControl.rejectNumericDirectoryOpen &&
        typeof args[1] === "number"
      ) {
        throw Object.assign(new Error("Injected Windows directory failure"), {
          code: "EPERM",
        });
      }
      const code =
        args[1] === "r" ? filesystemControl.openFailures.get(key) : undefined;
      if (code !== undefined) {
        filesystemControl.openFailures.delete(key);
        throw Object.assign(new Error(`Injected open failure: ${code}`), {
          code,
        });
      }
      return original.open(...args);
    },
    async lstat(
      path: Parameters<typeof original.lstat>[0],
      options?: Parameters<typeof original.lstat>[1],
    ) {
      const key = String(path);
      const code = filesystemControl.lstatFailures.get(key);
      if (code !== undefined) {
        filesystemControl.lstatFailures.delete(key);
        throw Object.assign(new Error(`Injected lstat failure: ${code}`), {
          code,
        });
      }
      return original.lstat(path, options as never);
    },
  };
});

const REPORT_NAME =
  /^zedbee-(?:scan-report|fix-plan)-[0-9]{14}(?:-[0-9]+)?\.json$/u;
const LOCK_FILE_NAME = ".lifecycle.lock";
const execFileAsync = promisify(execFile);

afterEach(() => {
  uuidControl.values.length = 0;
  filesystemControl.lstatFailures.clear();
  filesystemControl.openFailures.clear();
  filesystemControl.rejectNumericDirectoryOpen = false;
});

async function fixture(): Promise<{
  repositoryRoot: string;
  temporaryRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-report-store-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "private-repository-name");
  const temporaryRoot = join(root, "injected-temporary-root");
  await Promise.all([mkdir(repositoryRoot), mkdir(temporaryRoot)]);
  return { repositoryRoot, temporaryRoot };
}

async function waitForRegularFile(path: string): Promise<void> {
  await waitForAssertion(async () => {
    expect((await lstat(path)).isFile()).toBe(true);
  });
}

interface StoredState {
  readonly schemaVersion: number;
  readonly reports: readonly {
    readonly fileName: string;
    readonly createdAtMs: number;
  }[];
}

async function storedState(reportPath: string): Promise<{
  path: string;
  value: StoredState;
}> {
  const repositoryDirectory = dirname(reportPath);
  const stateName = (await readdir(repositoryDirectory)).find(
    (entry) => !REPORT_NAME.test(entry),
  );
  if (stateName === undefined) throw new Error("Lifecycle state not found");
  const path = join(repositoryDirectory, stateName);
  return {
    path,
    value: JSON.parse(await readFile(path, "utf8")) as StoredState,
  };
}

async function repositoryDirectory(
  repositoryRoot: string,
  temporaryRoot: string,
): Promise<string> {
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const repositoryHash = createHash("sha256")
    .update(canonicalRepositoryRoot, "utf8")
    .digest("hex")
    .slice(0, 32);
  const identity = userInfo();
  const namespace =
    Number.isSafeInteger(identity.uid) && identity.uid >= 0
      ? `zedbee-u${identity.uid}`
      : `zedbee-user-${createHash("sha256")
          .update(identity.username, "utf8")
          .digest("hex")
          .slice(0, 32)}`;
  return join(await realpath(temporaryRoot), namespace, repositoryHash);
}

describe("temporary report store", () => {
  it("maintains reports when Windows cannot open directory handles", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    filesystemControl.rejectNumericDirectoryOpen = true;
    const store = createTemporaryReportStore({
      temporaryRoot,
      platform: "win32",
    } as never);

    const maintained = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json: "windows\n",
    });

    expect(maintained.reportPath).toBeDefined();
    expect(maintained.warnings).toEqual([]);
    await expect(readFile(maintained.reportPath!, "utf8")).resolves.toBe(
      "windows\n",
    );
  });

  it("isolates identical repositories in stable safe per-user namespaces", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const rootUser = createTemporaryReportStore({
      temporaryRoot,
      userIdentity: { uid: 0, username: "root" },
    });
    const firstUser = createTemporaryReportStore({
      temporaryRoot,
      userIdentity: { uid: 501, username: "../unsafe\n\u001b\u202e" },
    });
    const secondUser = createTemporaryReportStore({
      temporaryRoot,
      userIdentity: { uid: 502, username: "same-name" },
    });
    const windowsUser = createTemporaryReportStore({
      temporaryRoot,
      userIdentity: { uid: -1, username: "../unsafe\n\u001b\u202e" },
    });

    const [rootResult, firstResult, secondResult, windowsResult] =
      await Promise.all([
        rootUser.maintain({
          repositoryRoot,
          maxAgeMs: 86_400_000,
          json: "root\n",
        }),
        firstUser.maintain({
          repositoryRoot,
          maxAgeMs: 86_400_000,
          json: "one\n",
        }),
        secondUser.maintain({
          repositoryRoot,
          maxAgeMs: 86_400_000,
          json: "two\n",
        }),
        windowsUser.maintain({
          repositoryRoot,
          maxAgeMs: 86_400_000,
          json: "windows\n",
        }),
      ]);

    expect(dirname(dirname(rootResult.reportPath!))).toBe(
      join(await realpath(temporaryRoot), "zedbee-u0"),
    );
    expect(dirname(dirname(firstResult.reportPath!))).toBe(
      join(await realpath(temporaryRoot), "zedbee-u501"),
    );
    expect(dirname(dirname(secondResult.reportPath!))).toBe(
      join(await realpath(temporaryRoot), "zedbee-u502"),
    );
    expect(dirname(dirname(windowsResult.reportPath!))).toBe(
      join(
        await realpath(temporaryRoot),
        "zedbee-user-349cba25e10ca9392b5a0733e36b4443",
      ),
    );
    expect(
      new Set([
        rootResult.reportPath,
        firstResult.reportPath,
        secondResult.reportPath,
        windowsResult.reportPath,
      ]),
    ).toHaveLength(4);
    expect((await readdir(temporaryRoot)).join("\n")).not.toContain("unsafe");
  });

  it("skips unsupported Windows directory fsync without masking POSIX errors", async () => {
    const { temporaryRoot } = await fixture();
    const missingDirectory = join(temporaryRoot, "does-not-exist");

    await expect(
      syncTemporaryReportDirectory(missingDirectory, "win32"),
    ).resolves.toBeUndefined();
    await expect(
      syncTemporaryReportDirectory(missingDirectory, "darwin"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes exact JSON into a compact private layout with a readable scan name", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const canonicalRepositoryRoot = await realpath(repositoryRoot);
    const canonicalTemporaryRoot = await realpath(temporaryRoot);
    const expectedHash = createHash("sha256")
      .update(canonicalRepositoryRoot, "utf8")
      .digest("hex")
      .slice(0, 32);
    const json = '{"findings":[{"message":"exact bytes"}]}\n';
    const now = new Date(2026, 7, 28, 11, 32, 45).getTime();

    const result = await createTemporaryReportStore({
      temporaryRoot,
      userIdentity: { uid: 501, username: "person" },
      now: () => now,
    }).maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json,
    });

    expect(result.reportPath).toBeDefined();
    expect(result.warnings).toEqual([]);
    const reportPath = result.reportPath!;
    const repositoryDirectory = dirname(reportPath);
    expect(basename(repositoryDirectory)).toBe(expectedHash);
    expect(dirname(dirname(repositoryDirectory))).toBe(canonicalTemporaryRoot);
    expect(basename(dirname(repositoryDirectory))).toBe("zedbee-u501");
    expect(basename(reportPath)).toBe("zedbee-scan-report-20260828113245.json");
    await expect(readFile(reportPath, "utf8")).resolves.toBe(json);

    const entries = await readdir(repositoryDirectory);
    const stateName = entries.find((entry) => !REPORT_NAME.test(entry));
    expect(stateName).toBeDefined();
    const state = await readFile(join(repositoryDirectory, stateName!), "utf8");
    expect(entries.join("\n")).not.toContain(basename(repositoryRoot));
    expect(state).not.toContain(basename(repositoryRoot));
    expect(state).not.toContain(canonicalRepositoryRoot);

    if (process.platform !== "win32") {
      expect((await stat(repositoryDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
      expect(
        (await stat(join(repositoryDirectory, stateName!))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("brands fix plans and adds a suffix only after a same-second collision", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const now = new Date(2026, 7, 28, 11, 32, 45).getTime();
    const store = createTemporaryReportStore({
      temporaryRoot,
      userIdentity: { uid: 501, username: "person" },
      now: () => now,
    });

    const first = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      reportKind: "fix-plan",
      json: "first\n",
    });
    const second = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      reportKind: "fix-plan",
      json: "second\n",
    });

    expect(basename(first.reportPath!)).toBe(
      "zedbee-fix-plan-20260828113245.json",
    );
    expect(basename(second.reportPath!)).toBe(
      "zedbee-fix-plan-20260828113245-2.json",
    );
    await expect(readFile(first.reportPath!, "utf8")).resolves.toBe("first\n");
    await expect(readFile(second.reportPath!, "utf8")).resolves.toBe(
      "second\n",
    );
  });

  it("continues allocating readable suffixes beyond sixteen same-second reports", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const now = new Date(2026, 7, 28, 11, 32, 45).getTime();
    const store = createTemporaryReportStore({
      temporaryRoot,
      now: () => now,
    });

    const reports = [];
    for (let index = 0; index < 17; index += 1) {
      reports.push(
        await store.maintain({
          repositoryRoot,
          maxAgeMs: 86_400_000,
          reportKind: "fix-plan",
          json: `${index}\n`,
        }),
      );
    }

    expect(reports.every((report) => report.warnings.length === 0)).toBe(true);
    expect(basename(reports[16]!.reportPath!)).toBe(
      "zedbee-fix-plan-20260828113245-17.json",
    );
  });

  it("does not publish a report path beneath an unsafe display root", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const unsafeRoot = join(temporaryRoot, "unsafe\u202e-root");
    await mkdir(unsafeRoot);

    const maintained = await createTemporaryReportStore({
      temporaryRoot: unsafeRoot,
    }).maintain({ repositoryRoot, maxAgeMs: 86_400_000, json: "complete\n" });

    expect(maintained.reportPath).toBeUndefined();
    expect(maintained.warnings).toContainEqual(
      expect.objectContaining({ code: "TEMP_REPORT_WRITE_FAILED" }),
    );
    expect(maintained.warnings.every((item) => item.path === undefined)).toBe(
      true,
    );
  });

  it("initializes a pristine managed directory without a cleanup warning", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();

    const maintained = await createTemporaryReportStore({
      temporaryRoot,
    }).maintain({ repositoryRoot, maxAgeMs: 86_400_000 });

    expect(maintained.warnings).toEqual([]);
    const managedDirectory = await repositoryDirectory(
      repositoryRoot,
      temporaryRoot,
    );
    expect(await readdir(managedDirectory)).toEqual([".lifecycle.json"]);
  });

  it("uses a fresh report name without overwriting earlier bytes", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });

    const first = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json: "first\n",
    });
    const second = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json: "second\n",
    });

    expect(first.reportPath).toBeDefined();
    expect(second.reportPath).toBeDefined();
    expect(second.reportPath).not.toBe(first.reportPath);
    await expect(readFile(first.reportPath!, "utf8")).resolves.toBe("first\n");
    await expect(readFile(second.reportPath!, "utf8")).resolves.toBe(
      "second\n",
    );
  });

  it("never overwrites a destination introduced while a report is being published", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const now = new Date(2026, 7, 28, 11, 32, 45).getTime();
    const store = createTemporaryReportStore({
      temporaryRoot,
      now: () => now,
    });
    await store.maintain({ repositoryRoot, maxAgeMs: 86_400_000 });
    const managedDirectory = await repositoryDirectory(
      repositoryRoot,
      temporaryRoot,
    );
    const firstUuid = "11111111-1111-4111-8111-111111111111";
    const stateWriteUuid = "22222222-2222-4222-8222-222222222222";
    uuidControl.values.push(firstUuid, stateWriteUuid);
    const racerContents = "destination owned by racing writer\n";
    const racerTemporary = join(managedDirectory, ".racer.tmp");
    const json = `${"report payload".repeat(350_000)}\n`;
    const maintenance = store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json,
    });
    const collision = (async (): Promise<string> => {
      const exclusiveLinkTemporary = `.report-${firstUuid}.tmp`;
      for (;;) {
        const entries = await readdir(managedDirectory);
        if (entries.includes(exclusiveLinkTemporary)) {
          const collisionPath = join(
            managedDirectory,
            "zedbee-scan-report-20260828113245.json",
          );
          await writeFile(racerTemporary, racerContents, {
            flag: "wx",
            mode: 0o600,
          });
          await rename(racerTemporary, collisionPath);
          return collisionPath;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();

    try {
      const collisionPath = await collision;
      const maintained = await maintenance;

      expect(maintained.reportPath).not.toBe(collisionPath);
      await expect(readFile(collisionPath, "utf8")).resolves.toBe(
        racerContents,
      );
      expect(maintained.reportPath).toBe(
        join(managedDirectory, "zedbee-scan-report-20260828113245-2.json"),
      );
      await expect(readFile(maintained.reportPath!, "utf8")).resolves.toBe(
        json,
      );
      expect((await storedState(maintained.reportPath!)).value).toEqual({
        schemaVersion: 2,
        reports: [
          {
            fileName: "zedbee-scan-report-20260828113245-2.json",
            createdAtMs: expect.any(Number),
          },
        ],
      });
      expect(
        (await readdir(managedDirectory)).some((entry) =>
          entry.endsWith(".tmp"),
        ),
      ).toBe(false);
    } finally {
      await maintenance.catch(() => undefined);
    }
  });

  it.each(["missing", "corrupt"] as const)(
    "warns for %s state and never adopts or removes unknown entries",
    async (stateKind) => {
      const { repositoryRoot, temporaryRoot } = await fixture();
      const store = createTemporaryReportStore({ temporaryRoot });
      const created = await store.maintain({
        repositoryRoot,
        maxAgeMs: 0,
        json: "must remain unknown\n",
      });
      expect(created.reportPath).toBeDefined();
      const state = await storedState(created.reportPath!);
      if (stateKind === "missing") {
        await unlink(state.path);
      } else {
        await writeFile(state.path, "{not valid json", { mode: 0o600 });
      }
      const unknownPath = join(dirname(created.reportPath!), "unknown-entry");
      await writeFile(unknownPath, "untouched", { mode: 0o600 });

      const maintained = await store.maintain({
        repositoryRoot,
        maxAgeMs: 0,
      });

      expect(maintained.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "TEMP_REPORT_CLEANUP_FAILED" }),
        ]),
      );
      await expect(readFile(created.reportPath!, "utf8")).resolves.toBe(
        "must remain unknown\n",
      );
      await expect(readFile(unknownPath, "utf8")).resolves.toBe("untouched");
      expect((await storedState(created.reportPath!)).value.reports).toEqual(
        [],
      );
    },
  );

  it("rejects a symlinked repository directory without touching its target", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const managedRepositoryDirectory = await repositoryDirectory(
      repositoryRoot,
      temporaryRoot,
    );
    await mkdir(dirname(managedRepositoryDirectory), { mode: 0o700 });
    const outside = join(dirname(temporaryRoot), "outside-symlink-target");
    await mkdir(outside);
    const sentinel = join(outside, "sentinel");
    await writeFile(sentinel, "untouched");
    await symlink(outside, managedRepositoryDirectory);

    const maintained = await createTemporaryReportStore({
      temporaryRoot,
    }).maintain({ repositoryRoot, maxAgeMs: 86_400_000, json: "blocked\n" });

    expect(maintained.reportPath).toBeUndefined();
    expect(maintained.warnings).toHaveLength(1);
    expect(maintained.warnings[0]).not.toHaveProperty("path");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("untouched");
    expect((await lstat(managedRepositoryDirectory)).isSymbolicLink()).toBe(
      true,
    );
  });

  it("rejects a non-directory managed boundary without changing it", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const managedRepositoryDirectory = await repositoryDirectory(
      repositoryRoot,
      temporaryRoot,
    );
    await mkdir(dirname(managedRepositoryDirectory), { mode: 0o700 });
    await writeFile(managedRepositoryDirectory, "not a directory", {
      mode: 0o600,
    });

    const maintained = await createTemporaryReportStore({
      temporaryRoot,
    }).maintain({ repositoryRoot, maxAgeMs: 86_400_000, json: "blocked\n" });

    expect(maintained.reportPath).toBeUndefined();
    expect(maintained.warnings).toHaveLength(1);
    expect(maintained.warnings[0]).not.toHaveProperty("path");
    await expect(readFile(managedRepositoryDirectory, "utf8")).resolves.toBe(
      "not a directory",
    );
  });

  it("treats oversized lifecycle state as corrupt without deleting a report", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const created = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
      json: "must survive oversized state\n",
    });
    const state = await storedState(created.reportPath!);
    await writeFile(
      state.path,
      `${JSON.stringify(state.value)}${" ".repeat(1024 * 1024)}`,
      { mode: 0o600 },
    );

    const maintained = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
    });

    expect(maintained.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TEMP_REPORT_CLEANUP_FAILED" }),
      ]),
    );
    expect(maintained.warnings.every((item) => item.path === undefined)).toBe(
      true,
    );
    await expect(readFile(created.reportPath!, "utf8")).resolves.toBe(
      "must survive oversized state\n",
    );
  });

  it("treats an over-count lifecycle as corrupt without deleting a report", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const created = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
      json: "must survive too many records\n",
    });
    const state = await storedState(created.reportPath!);
    const reports = [
      { fileName: basename(created.reportPath!), createdGeneration: 1 },
      ...Array.from({ length: 10_000 }, (_, index) => ({
        fileName: `00000000-0000-4000-8000-${index
          .toString(16)
          .padStart(12, "0")}.json`,
        createdGeneration: 1,
      })),
    ];
    const serialized = `${JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      reports,
    })}\n`;
    expect(Buffer.byteLength(serialized)).toBeLessThan(1024 * 1024);
    await writeFile(state.path, serialized, { mode: 0o600 });

    const maintained = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
    });

    expect(maintained.warnings).not.toHaveLength(0);
    expect(maintained.warnings.every((item) => item.path === undefined)).toBe(
      true,
    );
    await expect(readFile(created.reportPath!, "utf8")).resolves.toBe(
      "must survive too many records\n",
    );
  });

  it.each(["../outside.json", "/absolute/outside.json"])(
    "ignores corrupt tracked path %s without presenting it as a cleanup target",
    async (fileName) => {
      const { repositoryRoot, temporaryRoot } = await fixture();
      const store = createTemporaryReportStore({ temporaryRoot });
      const created = await store.maintain({
        repositoryRoot,
        maxAgeMs: 0,
        json: "known report\n",
      });
      const state = await storedState(created.reportPath!);
      const outside = join(dirname(temporaryRoot), "outside.json");
      await writeFile(outside, "untouched");
      await writeFile(
        state.path,
        `${JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          reports: [{ fileName, createdGeneration: 1 }],
        })}\n`,
      );

      const maintained = await store.maintain({
        repositoryRoot,
        maxAgeMs: 0,
      });

      expect(maintained.warnings).not.toHaveLength(0);
      expect(maintained.warnings.every((item) => item.path === undefined)).toBe(
        true,
      );
      await expect(readFile(outside, "utf8")).resolves.toBe("untouched");
      await expect(readFile(created.reportPath!, "utf8")).resolves.toBe(
        "known report\n",
      );
    },
  );

  it("never follows lifecycle state symlinks", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const created = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
      json: "tracked locally\n",
    });
    const state = await storedState(created.reportPath!);
    const outsideState = join(dirname(temporaryRoot), "outside-state.json");
    await writeFile(outsideState, `${JSON.stringify(state.value)}\n`, {
      mode: 0o600,
    });
    await unlink(state.path);
    await symlink(outsideState, state.path);

    const maintained = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
    });

    expect(maintained.warnings).not.toHaveLength(0);
    expect(maintained.warnings.every((item) => item.path === undefined)).toBe(
      true,
    );
    await expect(readFile(created.reportPath!, "utf8")).resolves.toBe(
      "tracked locally\n",
    );
    await expect(readFile(outsideState, "utf8")).resolves.toBe(
      `${JSON.stringify(state.value)}\n`,
    );
  });

  it.each(["symlink", "directory"] as const)(
    "leaves a tracked report replaced by a %s untouched",
    async (replacement) => {
      const { repositoryRoot, temporaryRoot } = await fixture();
      const store = createTemporaryReportStore({ temporaryRoot });
      const created = await store.maintain({
        repositoryRoot,
        maxAgeMs: 0,
        json: "replace me\n",
      });
      await unlink(created.reportPath!);
      const outside = join(dirname(temporaryRoot), "outside-report");
      await writeFile(outside, "untouched");
      if (replacement === "symlink") {
        await symlink(outside, created.reportPath!);
      } else {
        await mkdir(created.reportPath!);
      }

      const maintained = await store.maintain({
        repositoryRoot,
        maxAgeMs: 0,
      });

      expect(maintained.warnings).not.toHaveLength(0);
      expect(maintained.warnings.every((item) => item.path === undefined)).toBe(
        true,
      );
      await expect(readFile(outside, "utf8")).resolves.toBe("untouched");
      const replacementMetadata = await lstat(created.reportPath!);
      expect(
        replacement === "symlink"
          ? replacementMetadata.isSymbolicLink()
          : replacementMetadata.isDirectory(),
      ).toBe(true);
      expect((await storedState(created.reportPath!)).value.reports).toEqual([
        {
          fileName: basename(created.reportPath!),
          createdAtMs: expect.any(Number),
        },
      ]);
    },
  );

  it("drops a missing tracked file without presenting it as a cleanup failure", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const created = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
      json: "vanishes before cleanup\n",
    });
    await unlink(created.reportPath!);

    const maintained = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
    });

    expect(maintained.warnings).toEqual([]);
    expect((await storedState(created.reportPath!)).value.reports).toEqual([]);
  });

  it("retains a tracked report after a transient lstat failure and retries later", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const created = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
      json: "retry validation\n",
    });
    filesystemControl.lstatFailures.set(created.reportPath!, "EIO");

    const failed = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
    });

    expect(failed.warnings).toContainEqual(
      expect.objectContaining({
        code: "TEMP_REPORT_CLEANUP_FAILED",
        message: expect.stringContaining("could not be validated"),
      }),
    );
    expect(failed.warnings.every((item) => item.path === undefined)).toBe(true);
    await expect(readFile(created.reportPath!, "utf8")).resolves.toBe(
      "retry validation\n",
    );
    expect((await storedState(created.reportPath!)).value.reports).toEqual([
      {
        fileName: basename(created.reportPath!),
        createdAtMs: expect.any(Number),
      },
    ]);

    const retried = await store.maintain({
      repositoryRoot,
      maxAgeMs: 0,
    });

    expect(retried.warnings).toEqual([]);
    await expect(lstat(created.reportPath!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await storedState(created.reportPath!)).value.reports).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")(
    "retains a permission-denied report for successful cleanup retry",
    async () => {
      const { repositoryRoot, temporaryRoot } = await fixture();
      const store = createTemporaryReportStore({ temporaryRoot });
      const created = await store.maintain({
        repositoryRoot,
        maxAgeMs: 0,
        json: "immutable report\n",
      });
      await execFileAsync("/usr/bin/chflags", ["uchg", created.reportPath!]);
      try {
        const maintained = await store.maintain({
          repositoryRoot,
          maxAgeMs: 0,
        });
        expect(maintained.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "TEMP_REPORT_CLEANUP_FAILED",
              path: created.reportPath,
            }),
          ]),
        );
        await expect(readFile(created.reportPath!, "utf8")).resolves.toBe(
          "immutable report\n",
        );
        expect((await storedState(created.reportPath!)).value.reports).toEqual([
          {
            fileName: basename(created.reportPath!),
            createdAtMs: expect.any(Number),
          },
        ]);
      } finally {
        await execFileAsync("/usr/bin/chflags", [
          "nouchg",
          created.reportPath!,
        ]);
      }

      const retried = await store.maintain({
        repositoryRoot,
        maxAgeMs: 0,
      });

      expect(retried.warnings).toEqual([]);
      await expect(stat(created.reportPath!)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await storedState(created.reportPath!)).value).toEqual({
        schemaVersion: 2,
        reports: [],
      });
    },
  );

  it("rolls back a new report when lifecycle state cannot be replaced", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const created = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json: "initial\n",
    });
    const state = await storedState(created.reportPath!);
    await unlink(state.path);
    await mkdir(state.path);

    const maintained = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json: "must roll back\n",
    });

    expect(maintained.reportPath).toBeUndefined();
    expect(maintained.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TEMP_REPORT_WRITE_FAILED" }),
      ]),
    );
    const reportNames = (await readdir(dirname(created.reportPath!))).filter(
      (entry) => REPORT_NAME.test(entry),
    );
    expect(reportNames).toEqual([basename(created.reportPath!)]);
    expect((await lstat(state.path)).isDirectory()).toBe(true);
  });

  it("returns deeply immutable results and warnings", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const maintained = await createTemporaryReportStore({
      temporaryRoot,
    }).maintain({ repositoryRoot, maxAgeMs: 86_400_000 });

    expect(Object.isFrozen(maintained)).toBe(true);
    expect(Object.isFrozen(maintained.warnings)).toBe(true);
    expect(maintained.warnings).toEqual([]);
    expect(maintained.warnings.every((item) => Object.isFrozen(item))).toBe(
      true,
    );
  });

  it("refuses a report that would exceed the lifecycle record bound", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const initial = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json: "existing unknown file\n",
    });
    const state = await storedState(initial.reportPath!);
    const reports = Array.from({ length: 10_000 }, (_, index) => ({
      fileName: `zedbee-scan-report-19700101000000-${index + 2}.json`,
      createdGeneration: 1,
    }));
    await writeFile(
      state.path,
      `${JSON.stringify({ schemaVersion: 1, generation: 1, reports })}\n`,
      { mode: 0o600 },
    );

    const maintained = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json: "must not become untracked\n",
    });

    expect(maintained.reportPath).toBeUndefined();
    expect(maintained.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TEMP_REPORT_WRITE_FAILED" }),
      ]),
    );
    const persisted = JSON.parse(
      await readFile(state.path, "utf8"),
    ) as StoredState;
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.reports).toHaveLength(10_000);
    const reportNames = (await readdir(dirname(initial.reportPath!))).filter(
      (entry) => REPORT_NAME.test(entry),
    );
    expect(reportNames).toEqual([basename(initial.reportPath!)]);
  });

  it("serializes two concurrent writers without losing either lifecycle entry", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const firstJson = `${"a".repeat(512 * 1024)}\n`;
    const secondJson = `${"b".repeat(512 * 1024)}\n`;

    const [first, second] = await Promise.all([
      store.maintain({ repositoryRoot, maxAgeMs: 86_400_000, json: firstJson }),
      store.maintain({
        repositoryRoot,
        maxAgeMs: 86_400_000,
        json: secondJson,
      }),
    ]);

    expect(first.reportPath).toBeDefined();
    expect(second.reportPath).toBeDefined();
    expect(first.reportPath).not.toBe(second.reportPath);
    await expect(readFile(first.reportPath!, "utf8")).resolves.toBe(firstJson);
    await expect(readFile(second.reportPath!, "utf8")).resolves.toBe(
      secondJson,
    );
    const state = (await storedState(first.reportPath!)).value;
    expect(state.schemaVersion).toBe(2);
    expect(state.reports.map((report) => report.fileName).sort()).toEqual(
      [basename(first.reportPath!), basename(second.reportPath!)].sort(),
    );
  });

  it("times out on an existing lock without deleting it or changing lifecycle state", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const created = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json: "existing\n",
    });
    const state = await storedState(created.reportPath!);
    const stateBefore = await readFile(state.path, "utf8");
    const lockPath = join(dirname(created.reportPath!), LOCK_FILE_NAME);
    await writeFile(lockPath, "held by another process", {
      flag: "wx",
      mode: 0o600,
    });
    const dateNow = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(1_000_000);
    // Advance the runtime's monotonic clock across its two-second lock limit
    // without imposing a second wall-clock deadline on this test.
    const monotonicNow = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1_999)
      .mockReturnValue(2_000);

    const maintained = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json: "must not be written\n",
    });
    monotonicNow.mockRestore();
    dateNow.mockRestore();

    expect(maintained.reportPath).toBeUndefined();
    expect(maintained.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TEMP_REPORT_CLEANUP_FAILED" }),
      ]),
    );
    expect(maintained.warnings).toContainEqual(
      expect.objectContaining({
        code: "TEMP_REPORT_CLEANUP_FAILED",
        path: lockPath,
      }),
    );
    await expect(readFile(lockPath, "utf8")).resolves.toBe(
      "held by another process",
    );
    await expect(readFile(state.path, "utf8")).resolves.toBe(stateBefore);
    const reportNames = (await readdir(dirname(created.reportPath!))).filter(
      (entry) => REPORT_NAME.test(entry),
    );
    expect(reportNames).toEqual([basename(created.reportPath!)]);
  });

  it.skipIf(process.platform !== "darwin")(
    "names a validated lock when its unlink fails",
    async () => {
      const { repositoryRoot, temporaryRoot } = await fixture();
      const store = createTemporaryReportStore({ temporaryRoot });
      const initial = await store.maintain({
        repositoryRoot,
        maxAgeMs: 86_400_000,
        json: "initial\n",
      });
      const lockPath = join(dirname(initial.reportPath!), LOCK_FILE_NAME);
      const pending = store.maintain({
        repositoryRoot,
        maxAgeMs: 86_400_000,
        json: `${"lock payload".repeat(500_000)}\n`,
      });
      await waitForRegularFile(lockPath);
      await execFileAsync("/usr/bin/chflags", ["uchg", lockPath]);
      try {
        const maintained = await pending;
        expect(maintained.warnings).toContainEqual(
          expect.objectContaining({
            code: "TEMP_REPORT_CLEANUP_FAILED",
            path: lockPath,
          }),
        );
      } finally {
        await execFileAsync("/usr/bin/chflags", ["nouchg", lockPath]);
        await unlink(lockPath);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "omits the removed lock path when only directory synchronization fails",
    async () => {
      const { repositoryRoot, temporaryRoot } = await fixture();
      const store = createTemporaryReportStore({ temporaryRoot });
      const initial = await store.maintain({
        repositoryRoot,
        maxAgeMs: 86_400_000,
        json: "initial\n",
      });
      const directory = dirname(initial.reportPath!);
      const lockPath = join(directory, LOCK_FILE_NAME);
      const pending = store.maintain({
        repositoryRoot,
        maxAgeMs: 86_400_000,
        json: `${"sync payload".repeat(500_000)}\n`,
      });
      await waitForRegularFile(lockPath);
      await chmod(directory, 0o300);
      try {
        const maintained = await pending;
        expect(maintained.warnings).toContainEqual(
          expect.objectContaining({
            code: "TEMP_REPORT_CLEANUP_FAILED",
            message: expect.stringContaining(
              "released lock directory could not be synchronized",
            ),
          }),
        );
        expect(
          maintained.warnings
            .filter((item) => item.message.includes("released lock"))
            .every((item) => item.path === undefined),
        ).toBe(true);
        await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await chmod(directory, 0o700);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not name an expired report after unlink succeeds but directory sync fails",
    async () => {
      const { repositoryRoot, temporaryRoot } = await fixture();
      const store = createTemporaryReportStore({ temporaryRoot });
      const created = await store.maintain({
        repositoryRoot,
        maxAgeMs: 0,
        json: "expires\n",
      });
      const directory = dirname(created.reportPath!);
      const state = await storedState(created.reportPath!);
      await writeFile(state.path, JSON.stringify(state.value), "utf8");
      filesystemControl.openFailures.set(directory, "EACCES");
      const maintained = await store.maintain({
        repositoryRoot,
        maxAgeMs: 0,
      });
      const warning = maintained.warnings.find((item) =>
        item.message.includes("removed report's directory"),
      );
      expect(warning).toBeDefined();
      expect(warning?.path).toBeUndefined();
      await expect(lstat(created.reportPath!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("removes a report on the first maintenance run after its maximum age", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    let now = Date.UTC(2026, 7, 20, 12);
    const store = createTemporaryReportStore({
      temporaryRoot,
      now: () => now,
    });
    const created = await store.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json: "complete\n",
    });

    now += 86_400_000 - 1;
    await store.maintain({ repositoryRoot, maxAgeMs: 86_400_000 });
    await expect(lstat(created.reportPath!)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });

    now += 1;
    await store.maintain({ repositoryRoot, maxAgeMs: 86_400_000 });
    await expect(lstat(created.reportPath!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("migrates tracked run-based reports using their existing file time", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const initial = createTemporaryReportStore({ temporaryRoot });
    const created = await initial.maintain({
      repositoryRoot,
      maxAgeMs: 86_400_000,
      json: "legacy\n",
    });
    const state = await storedState(created.reportPath!);
    const now = Date.UTC(2026, 7, 20, 12);
    const createdAt = now - 86_400_001;
    await utimes(created.reportPath!, createdAt / 1000, createdAt / 1000);
    await writeFile(
      state.path,
      `${JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        reports: [
          { fileName: basename(created.reportPath!), createdGeneration: 1 },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    const migrated = createTemporaryReportStore({
      temporaryRoot,
      now: () => now,
    });
    await migrated.maintain({ repositoryRoot, maxAgeMs: 86_400_000 });

    await expect(lstat(created.reportPath!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
