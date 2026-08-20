import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { createTemporaryReportStore } from "../../src/reporting/temporary-reports.js";

const REPORT_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;
const LOCK_FILE_NAME = ".lifecycle.lock";
const execFileAsync = promisify(execFile);

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

interface StoredState {
  readonly schemaVersion: number;
  readonly generation: number;
  readonly reports: readonly {
    readonly fileName: string;
    readonly createdGeneration: number;
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
    .digest("hex");
  return join(await realpath(temporaryRoot), "zedbee-reports", repositoryHash);
}

describe("temporary report store", () => {
  it("writes exact JSON into a hashed private layout", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const canonicalRepositoryRoot = await realpath(repositoryRoot);
    const canonicalTemporaryRoot = await realpath(temporaryRoot);
    const expectedHash = createHash("sha256")
      .update(canonicalRepositoryRoot, "utf8")
      .digest("hex");
    const json = '{"findings":[{"message":"exact bytes"}]}\n';

    const result = await createTemporaryReportStore({ temporaryRoot }).maintain(
      {
        repositoryRoot,
        retentionRuns: 5,
        json,
      },
    );

    expect(result.reportPath).toBeDefined();
    const reportPath = result.reportPath!;
    const repositoryDirectory = dirname(reportPath);
    expect(repositoryDirectory).toBe(
      join(canonicalTemporaryRoot, "zedbee-reports", expectedHash),
    );
    expect(basename(reportPath)).toMatch(REPORT_NAME);
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

  it("uses a fresh report name without overwriting earlier bytes", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });

    const first = await store.maintain({
      repositoryRoot,
      retentionRuns: 5,
      json: "first\n",
    });
    const second = await store.maintain({
      repositoryRoot,
      retentionRuns: 5,
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

  it("expires a report on the fifth subsequent retained generation", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const created = await store.maintain({
      repositoryRoot,
      retentionRuns: 5,
      json: "retained\n",
    });
    expect(created.reportPath).toBeDefined();

    for (let subsequentRun = 1; subsequentRun <= 4; subsequentRun += 1) {
      await store.maintain({ repositoryRoot, retentionRuns: 5 });
      await expect(readFile(created.reportPath!, "utf8")).resolves.toBe(
        "retained\n",
      );
    }
    expect((await storedState(created.reportPath!)).value.generation).toBe(5);

    await store.maintain({ repositoryRoot, retentionRuns: 5 });

    await expect(stat(created.reportPath!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await storedState(created.reportPath!)).value).toEqual({
      schemaVersion: 1,
      generation: 6,
      reports: [],
    });
  });

  it.each(["missing", "corrupt"] as const)(
    "warns for %s state and never adopts or removes unknown entries",
    async (stateKind) => {
      const { repositoryRoot, temporaryRoot } = await fixture();
      const store = createTemporaryReportStore({ temporaryRoot });
      const created = await store.maintain({
        repositoryRoot,
        retentionRuns: 1,
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
        retentionRuns: 1,
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
    const reportsRoot = join(await realpath(temporaryRoot), "zedbee-reports");
    await mkdir(reportsRoot, { mode: 0o700 });
    const managedRepositoryDirectory = await repositoryDirectory(
      repositoryRoot,
      temporaryRoot,
    );
    const outside = join(dirname(temporaryRoot), "outside-symlink-target");
    await mkdir(outside);
    const sentinel = join(outside, "sentinel");
    await writeFile(sentinel, "untouched");
    await symlink(outside, managedRepositoryDirectory);

    const maintained = await createTemporaryReportStore({
      temporaryRoot,
    }).maintain({ repositoryRoot, retentionRuns: 5, json: "blocked\n" });

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
    const reportsRoot = join(await realpath(temporaryRoot), "zedbee-reports");
    await mkdir(reportsRoot, { mode: 0o700 });
    const managedRepositoryDirectory = await repositoryDirectory(
      repositoryRoot,
      temporaryRoot,
    );
    await writeFile(managedRepositoryDirectory, "not a directory", {
      mode: 0o600,
    });

    const maintained = await createTemporaryReportStore({
      temporaryRoot,
    }).maintain({ repositoryRoot, retentionRuns: 5, json: "blocked\n" });

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
      retentionRuns: 1,
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
      retentionRuns: 1,
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
      retentionRuns: 1,
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
      retentionRuns: 1,
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
        retentionRuns: 1,
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
        retentionRuns: 1,
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
      retentionRuns: 1,
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
      retentionRuns: 1,
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
        retentionRuns: 1,
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
        retentionRuns: 1,
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
    },
  );

  it("does not present a missing tracked file as a validated cleanup target", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const created = await store.maintain({
      repositoryRoot,
      retentionRuns: 1,
      json: "vanishes before cleanup\n",
    });
    await unlink(created.reportPath!);

    const maintained = await store.maintain({
      repositoryRoot,
      retentionRuns: 1,
    });

    expect(maintained.warnings).not.toHaveLength(0);
    expect(maintained.warnings.every((item) => item.path === undefined)).toBe(
      true,
    );
  });

  it.skipIf(process.platform !== "darwin")(
    "reports an unlink permission failure only with the validated report path",
    async () => {
      const { repositoryRoot, temporaryRoot } = await fixture();
      const store = createTemporaryReportStore({ temporaryRoot });
      const created = await store.maintain({
        repositoryRoot,
        retentionRuns: 1,
        json: "immutable report\n",
      });
      await execFileAsync("/usr/bin/chflags", ["uchg", created.reportPath!]);
      try {
        const maintained = await store.maintain({
          repositoryRoot,
          retentionRuns: 1,
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
      } finally {
        await execFileAsync("/usr/bin/chflags", [
          "nouchg",
          created.reportPath!,
        ]);
      }
    },
  );

  it("rolls back a new report when lifecycle state cannot be replaced", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const created = await store.maintain({
      repositoryRoot,
      retentionRuns: 5,
      json: "initial\n",
    });
    const state = await storedState(created.reportPath!);
    await unlink(state.path);
    await mkdir(state.path);

    const maintained = await store.maintain({
      repositoryRoot,
      retentionRuns: 5,
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
    }).maintain({ repositoryRoot, retentionRuns: 5 });

    expect(Object.isFrozen(maintained)).toBe(true);
    expect(Object.isFrozen(maintained.warnings)).toBe(true);
    expect(maintained.warnings.length).toBeGreaterThan(0);
    expect(maintained.warnings.every((item) => Object.isFrozen(item))).toBe(
      true,
    );
  });

  it("refuses a report that would exceed the lifecycle record bound", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const initial = await store.maintain({
      repositoryRoot,
      retentionRuns: 5,
      json: "existing unknown file\n",
    });
    const state = await storedState(initial.reportPath!);
    const reports = Array.from({ length: 10_000 }, (_, index) => ({
      fileName: `00000000-0000-4000-8000-${index
        .toString(16)
        .padStart(12, "0")}.json`,
      createdGeneration: 1,
    }));
    await writeFile(
      state.path,
      `${JSON.stringify({ schemaVersion: 1, generation: 1, reports })}\n`,
      { mode: 0o600 },
    );

    const maintained = await store.maintain({
      repositoryRoot,
      retentionRuns: 5,
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
    expect(persisted.generation).toBe(2);
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
      store.maintain({ repositoryRoot, retentionRuns: 5, json: firstJson }),
      store.maintain({ repositoryRoot, retentionRuns: 5, json: secondJson }),
    ]);

    expect(first.reportPath).toBeDefined();
    expect(second.reportPath).toBeDefined();
    expect(first.reportPath).not.toBe(second.reportPath);
    await expect(readFile(first.reportPath!, "utf8")).resolves.toBe(firstJson);
    await expect(readFile(second.reportPath!, "utf8")).resolves.toBe(
      secondJson,
    );
    const state = (await storedState(first.reportPath!)).value;
    expect(state.generation).toBe(2);
    expect(state.reports.map((report) => report.fileName).sort()).toEqual(
      [basename(first.reportPath!), basename(second.reportPath!)].sort(),
    );
  });

  it("times out on an existing lock without deleting it or changing lifecycle state", async () => {
    const { repositoryRoot, temporaryRoot } = await fixture();
    const store = createTemporaryReportStore({ temporaryRoot });
    const created = await store.maintain({
      repositoryRoot,
      retentionRuns: 5,
      json: "existing\n",
    });
    const state = await storedState(created.reportPath!);
    const stateBefore = await readFile(state.path, "utf8");
    const lockPath = join(dirname(created.reportPath!), LOCK_FILE_NAME);
    await writeFile(lockPath, "held by another process", {
      flag: "wx",
      mode: 0o600,
    });
    const startedAt = Date.now();

    const maintained = await store.maintain({
      repositoryRoot,
      retentionRuns: 5,
      json: "must not be written\n",
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(1_800);
    expect(elapsed).toBeLessThan(3_000);
    expect(maintained.reportPath).toBeUndefined();
    expect(maintained.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TEMP_REPORT_CLEANUP_FAILED" }),
      ]),
    );
    expect(maintained.warnings.every((item) => item.path === undefined)).toBe(
      true,
    );
    await expect(readFile(lockPath, "utf8")).resolves.toBe(
      "held by another process",
    );
    await expect(readFile(state.path, "utf8")).resolves.toBe(stateBefore);
    const reportNames = (await readdir(dirname(created.reportPath!))).filter(
      (entry) => REPORT_NAME.test(entry),
    );
    expect(reportNames).toEqual([basename(created.reportPath!)]);
  }, 5_000);
});
