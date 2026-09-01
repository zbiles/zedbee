import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { sanitizeCheckResult } from "../../src/checks/sanitize-result.js";
import type { CheckResult } from "../../src/core/types.js";
import { GitClient } from "../../src/git/client.js";
import { GitCommandError } from "../../src/git/errors.js";
import {
  buildCommitSnapshotPair,
  buildSnapshotPair,
  type SnapshotPair,
} from "../../src/git/snapshot.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import {
  validateReportableSnapshotPath,
  validateSnapshotPath,
} from "../../src/git/snapshot-path.js";
import { createGitRepository } from "../helpers/git-repository.js";

const snapshotRootFailure = vi.hoisted(() => ({
  failCanonicalization: false,
  failTargetDirectoryCreation: false,
  temporaryParent: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async mkdtemp(...args: Parameters<typeof actual.mkdtemp>) {
      const created = await actual.mkdtemp(...args);
      snapshotRootFailure.temporaryParent = created;
      return created;
    },
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      if (
        snapshotRootFailure.failTargetDirectoryCreation &&
        basename(String(args[0])) === "target" &&
        String(args[0]).includes("zedbee-snapshot-")
      ) {
        throw new Error("target directory creation failed");
      }
      return actual.mkdir(...args);
    },
    async realpath(path: Parameters<typeof actual.realpath>[0]) {
      if (
        snapshotRootFailure.failCanonicalization &&
        path === snapshotRootFailure.temporaryParent
      ) {
        throw new Error("canonicalization failed");
      }
      return actual.realpath(path);
    },
  };
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const TEST_BLOB = "0123456789012345678901234567890123456789";

function stagedRecord(path = "value.ts"): string {
  return `100644 ${TEST_BLOB} 0\t${path}\0`;
}

function treeRecord(path = "value.ts"): string {
  return `100644 blob ${TEST_BLOB}\t${path}\0`;
}

function debugRecord(path = "value.ts"): string {
  return `${path}\0  ctime: 0:0\n  mtime: 0:0\n  dev: 0\tino: 0\n  uid: 0\tgid: 0\n  size: 0\tflags: 0\n`;
}

describe("buildSnapshotPair", () => {
  it("cleans an owned temporary root when canonicalization fails", async () => {
    snapshotRootFailure.failCanonicalization = true;
    const git = {
      async run() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as unknown as GitClient;

    try {
      await expect(buildSnapshotPair("/repo", git)).rejects.toThrow(
        "canonicalization failed",
      );
      expect(snapshotRootFailure.temporaryParent).not.toBe("");
      expect(await pathExists(snapshotRootFailure.temporaryParent)).toBe(false);
    } finally {
      snapshotRootFailure.failCanonicalization = false;
      snapshotRootFailure.temporaryParent = "";
    }
  });

  it("cleans an owned temporary root when snapshot directory creation fails", async () => {
    snapshotRootFailure.failTargetDirectoryCreation = true;
    const git = {
      async run() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as unknown as GitClient;

    try {
      await expect(buildSnapshotPair("/repo", git)).rejects.toThrow(
        "target directory creation failed",
      );
      expect(snapshotRootFailure.temporaryParent).not.toBe("");
      expect(await pathExists(snapshotRootFailure.temporaryParent)).toBe(false);
    } finally {
      snapshotRootFailure.failTargetDirectoryCreation = false;
      await rm(snapshotRootFailure.temporaryParent, {
        recursive: true,
        force: true,
      });
      snapshotRootFailure.temporaryParent = "";
    }
  });

  it("requires a target reference in snapshot pairs", () => {
    type RequiredTargetReference = SnapshotPair extends {
      targetRef: string;
    }
      ? true
      : false;
    const targetReferenceIsRequired: RequiredTargetReference = true;

    expect(targetReferenceIsRequired).toBe(true);
  });

  it("creates a canonical trusted snapshot root below the canonical OS temp root", async () => {
    const repository = await createGitRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "value.ts"]);
    const snapshots = await buildSnapshotPair(
      repository.root,
      new GitClient(repository.root),
    );
    onTestFinished(snapshots.cleanup);

    const snapshotRoot = dirname(snapshots.targetDir);
    const canonicalTempRoot = await realpath(tmpdir());
    expect(isAbsolute(snapshotRoot)).toBe(true);
    expect(await realpath(snapshotRoot)).toBe(snapshotRoot);
    expect(relative(canonicalTempRoot, snapshotRoot)).not.toMatch(
      /^\.\.(?:[/\\]|$)/,
    );
    expect(basename(snapshotRoot)).toMatch(/^zedbee-snapshot-/);
    expect(await validateSnapshotPath(snapshotRoot)).toBe(snapshotRoot);

    const trustedReportPath = validateReportableSnapshotPath(snapshotRoot);
    const result = sanitizeCheckResult(
      {
        checkId: "snapshot-cleanup",
        status: "incomplete",
        durationMs: 0,
        findings: [],
        error: {
          code: "SNAPSHOT_CLEANUP_FAILED",
          message: "Zedbee could not remove its temporary snapshot.",
        },
      } as CheckResult,
      { temporaryPath: trustedReportPath },
    );
    expect(result.error?.temporaryPath).toBe(snapshotRoot);
  });

  it.each([
    ["non-Zedbee temp path", "/tmp/not-zedbee"],
    ["relative path", "."],
  ])("rejects a literal %s", async (_label, path) => {
    await expect(validateSnapshotPath(path)).rejects.toThrow();
    expect(() => validateReportableSnapshotPath(path)).toThrow();
  });

  it("rejects an existing directory outside the canonical temp root", async () => {
    const repository = await createGitRepository();

    await expect(validateSnapshotPath(repository.root)).rejects.toThrow();
    expect(() => validateReportableSnapshotPath(repository.root)).toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a snapshot symlink whose realpath identity differs",
    async () => {
      const created = await mkdtemp(join(tmpdir(), "zedbee-snapshot-target-"));
      const canonicalTarget = await realpath(created);
      const link = `${canonicalTarget}-symlink`;
      await symlink(canonicalTarget, link, "dir");
      onTestFinished(async () => {
        await rm(link);
        await rm(canonicalTarget, { recursive: true });
      });

      await expect(validateSnapshotPath(link)).rejects.toThrow();
      expect(() => validateReportableSnapshotPath(link)).toThrow();
    },
  );

  it("materializes HEAD and the index without observing later working-tree edits", async () => {
    const repository = await createGitRepository();
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.commitAll("initial");

    await repository.write("src/value.ts", "export const value = 2;\n");
    await repository.git(["add", "--", "src/value.ts"]);
    await repository.write("src/value.ts", "export const value = 3;\n");

    const beforeStatus = await repository.git([
      "status",
      "--porcelain=v1",
      "-z",
    ]);
    const beforeIndex = await readFile(join(repository.root, ".git", "index"));
    const snapshots = await buildSnapshotPair(
      repository.root,
      new GitClient(repository.root),
    );
    onTestFinished(snapshots.cleanup);

    expect(
      await readFile(join(snapshots.baselineDir, "src/value.ts"), "utf8"),
    ).toBe("export const value = 1;\n");
    expect(
      await readFile(join(snapshots.targetDir, "src/value.ts"), "utf8"),
    ).toBe("export const value = 2;\n");
    expect(await repository.read("src/value.ts")).toBe(
      "export const value = 3;\n",
    );

    await snapshots.cleanup();
    const afterStatus = await repository.git([
      "status",
      "--porcelain=v1",
      "-z",
    ]);
    const afterIndex = await readFile(join(repository.root, ".git", "index"));
    expect(afterStatus.stdout).toBe(beforeStatus.stdout);
    expect(afterIndex).toEqual(beforeIndex);
  });

  it("writes exact index and commit blob bytes without EOL conversion", async () => {
    const repository = await createGitRepository();
    const expectedText = Buffer.from("line one\nline two\n", "utf8");
    const expectedBinary = Buffer.from([0xc3, 0x28, 0x00, 0xff, 0x0a]);
    await repository.write(".gitattributes", "*.txt text eol=crlf\n");
    await writeFile(join(repository.root, "value.txt"), expectedText);
    await writeFile(join(repository.root, "binary.dat"), expectedBinary);
    await repository.commitAll("exact blobs");
    const commit = (await repository.git(["rev-parse", "HEAD"])).stdout;

    const indexPair = await buildSnapshotPair(
      repository.root,
      new GitClient(repository.root),
    );
    onTestFinished(indexPair.cleanup);
    const commitPair = await buildCommitSnapshotPair(
      repository.root,
      new GitClient(repository.root),
      commit,
      commit,
    );
    onTestFinished(commitPair.cleanup);

    expect(await readFile(join(indexPair.targetDir, "value.txt"))).toEqual(
      expectedText,
    );
    expect(await readFile(join(indexPair.targetDir, "binary.dat"))).toEqual(
      expectedBinary,
    );
    expect(await readFile(join(commitPair.targetDir, "value.txt"))).toEqual(
      expectedText,
    );
    expect(await readFile(join(commitPair.targetDir, "binary.dat"))).toEqual(
      expectedBinary,
    );
  });

  it.runIf(process.platform !== "win32").each(["smudge", "process"] as const)(
    "does not execute a configured %s filter while materializing selected blobs",
    async (filterKind) => {
      const repository = await createGitRepository();
      const expected = Buffer.from("exact filtered bytes\n", "utf8");
      await repository.write(".gitattributes", "*.dat filter=zedbee\n");
      await writeFile(join(repository.root, "filtered.dat"), expected);
      await repository.commitAll("filtered blob");
      const commit = (await repository.git(["rev-parse", "HEAD"])).stdout;
      const sentinel = join(
        repository.root,
        `${filterKind.toUpperCase()}_FILTER_EXECUTED`,
      );
      const filter = join(repository.root, `${filterKind}-filter.sh`);
      await writeFile(
        filter,
        filterKind === "smudge"
          ? `#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\ncat\n`
          : `#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\nexit 1\n`,
      );
      await chmod(filter, 0o755);
      await repository.git(["config", `filter.zedbee.${filterKind}`, filter]);
      await repository.git(["config", "filter.zedbee.required", "true"]);

      const indexPair = await buildSnapshotPair(
        repository.root,
        new GitClient(repository.root),
      );
      onTestFinished(indexPair.cleanup);
      const commitPair = await buildCommitSnapshotPair(
        repository.root,
        new GitClient(repository.root),
        commit,
        commit,
      );
      onTestFinished(commitPair.cleanup);

      expect(await readFile(join(indexPair.targetDir, "filtered.dat"))).toEqual(
        expected,
      );
      expect(
        await readFile(join(commitPair.targetDir, "filtered.dat")),
      ).toEqual(expected);
      await expect(access(sentinel)).rejects.toThrow();
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a configured LFS pointer exact without invoking LFS filters",
    async () => {
      const repository = await createGitRepository();
      const pointer = Buffer.from(
        "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 42\n",
        "utf8",
      );
      await repository.write(
        ".gitattributes",
        "*.lfs filter=lfs diff=lfs merge=lfs -text\n",
      );
      await writeFile(join(repository.root, "asset.lfs"), pointer);
      await repository.commitAll("LFS pointer");
      const commit = (await repository.git(["rev-parse", "HEAD"])).stdout;
      const sentinel = join(repository.root, "LFS_FILTER_EXECUTED");
      const filter = join(repository.root, "lfs-filter.sh");
      await writeFile(
        filter,
        `#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\nexit 1\n`,
      );
      await chmod(filter, 0o755);
      await repository.git(["config", "filter.lfs.process", filter]);
      await repository.git(["config", "filter.lfs.smudge", filter]);
      await repository.git(["config", "filter.lfs.required", "true"]);

      const pair = await buildCommitSnapshotPair(
        repository.root,
        new GitClient(repository.root),
        commit,
        commit,
      );
      onTestFinished(pair.cleanup);

      expect(await readFile(join(pair.targetDir, "asset.lfs"))).toEqual(
        pointer,
      );
      expect(pair.unsupportedEntries).toContainEqual({
        path: "asset.lfs",
        kind: "git-lfs-pointer",
      });
      await expect(access(sentinel)).rejects.toThrow();
    },
  );

  it("uses an empty baseline for an initial commit", async () => {
    const repository = await createGitRepository();
    await repository.write("new.ts", "export const created = true;\n");
    await repository.git(["add", "--", "new.ts"]);

    const snapshots = await buildSnapshotPair(
      repository.root,
      new GitClient(repository.root),
    );
    onTestFinished(snapshots.cleanup);

    expect(snapshots.baselineRef).toBeNull();
    expect(await readdir(snapshots.baselineDir)).toEqual([]);
    expect(
      await readFile(join(snapshots.targetDir, "new.ts"), "utf8"),
    ).toContain("created = true");
  });

  it("represents additions, deletions, renames, modes, and paths with spaces", async () => {
    const repository = await createGitRepository();
    await repository.write("delete.ts", "export const removed = true;\n");
    await repository.write("rename-old.ts", "export const renamed = true;\n");
    await repository.write("script.sh", "#!/bin/sh\nexit 0\n");
    await repository.commitAll("initial shapes");

    await rm(join(repository.root, "delete.ts"));
    await repository.git(["mv", "rename-old.ts", "rename new.ts"]);
    await repository.write(
      "path with spaces.ts",
      "export const spaced = true;\n",
    );
    await chmod(join(repository.root, "script.sh"), 0o755);
    await repository.git(["add", "--all"]);

    const snapshots = await buildSnapshotPair(
      repository.root,
      new GitClient(repository.root),
    );
    onTestFinished(snapshots.cleanup);

    expect(await pathExists(join(snapshots.baselineDir, "delete.ts"))).toBe(
      true,
    );
    expect(await pathExists(join(snapshots.targetDir, "delete.ts"))).toBe(
      false,
    );
    expect(await pathExists(join(snapshots.baselineDir, "rename-old.ts"))).toBe(
      true,
    );
    expect(await pathExists(join(snapshots.targetDir, "rename-old.ts"))).toBe(
      false,
    );
    expect(await pathExists(join(snapshots.targetDir, "rename new.ts"))).toBe(
      true,
    );
    expect(
      await pathExists(join(snapshots.targetDir, "path with spaces.ts")),
    ).toBe(true);
    if (process.platform !== "win32") {
      expect(
        (await lstat(join(snapshots.targetDir, "script.sh"))).mode & 0o111,
      ).not.toBe(0);
    }
  });

  it.runIf(process.platform !== "win32")(
    "preserves staged symbolic links",
    async () => {
      const repository = await createGitRepository();
      await repository.write("target.txt", "target\n");
      await symlink("target.txt", join(repository.root, "link.txt"));
      await repository.git(["add", "--", "target.txt", "link.txt"]);

      const snapshots = await buildSnapshotPair(
        repository.root,
        new GitClient(repository.root),
      );
      onTestFinished(snapshots.cleanup);

      expect(
        (await lstat(join(snapshots.targetDir, "link.txt"))).isSymbolicLink(),
      ).toBe(true);
      expect(
        await readFile(join(snapshots.targetDir, "link.txt"), "utf8"),
      ).toBe("target\n");
    },
  );

  it("cleans only its temporary parent and cleanup is idempotent", async () => {
    const repository = await createGitRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "value.ts"]);
    const snapshots = await buildSnapshotPair(
      repository.root,
      new GitClient(repository.root),
    );
    const temporaryParent = join(snapshots.targetDir, "..");

    await snapshots.cleanup();
    await snapshots.cleanup();

    expect(await pathExists(temporaryParent)).toBe(false);
    expect(await pathExists(repository.root)).toBe(true);
  });

  it("aborts a target blob read and removes its temporary snapshot root", async () => {
    let signalReceived = false;
    let markBlobReadStarted: (() => void) | undefined;
    const blobReadStarted = new Promise<void>((resolve) => {
      markBlobReadStarted = resolve;
    });
    const git = {
      async run(args: readonly string[]) {
        if (args[1] === "--stage") {
          return { stdout: stagedRecord(), stderr: "", exitCode: 0 };
        }
        if (args[1] === "--debug") {
          return { stdout: debugRecord(), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async runBytes(
        _args: readonly string[],
        options: { signal?: AbortSignal } = {},
      ) {
        markBlobReadStarted?.();
        return new Promise<never>((_resolve, reject) => {
          const abort = () => {
            signalReceived = true;
            reject(
              new GitCommandError("GIT_ABORTED", "Git command was aborted."),
            );
          };
          if (options.signal?.aborted === true) {
            abort();
          } else {
            options.signal?.addEventListener("abort", abort, { once: true });
          }
        });
      },
      async tryRun() {
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    } as unknown as GitClient;
    const controller = new AbortController();
    const build = buildSnapshotPair("/repo", git, controller.signal);
    await blobReadStarted;
    controller.abort();

    const failure = await Promise.race([
      build.then(
        () => new Error("snapshot construction unexpectedly completed"),
        (error: unknown) => error,
      ),
      new Promise<Error>((resolve) => {
        setTimeout(
          () => resolve(new Error("cat-file did not receive abort signal")),
          100,
        );
      }),
    ]);

    expect(signalReceived).toBe(true);
    expect(failure).toMatchObject({ code: "GIT_ABORTED" });
    expect(await pathExists(snapshotRootFailure.temporaryParent)).toBe(false);
  });

  it("aborts a baseline blob read and removes its temporary snapshot root", async () => {
    let signalReceived = false;
    let markBaselineBlobReadStarted: (() => void) | undefined;
    const baselineBlobReadStarted = new Promise<void>((resolve) => {
      markBaselineBlobReadStarted = resolve;
    });
    const git = {
      async run(args: readonly string[]) {
        if (args[0] === "ls-tree") {
          return { stdout: treeRecord(), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async runBytes(
        _args: readonly string[],
        options: { signal?: AbortSignal } = {},
      ) {
        markBaselineBlobReadStarted?.();
        return new Promise<never>((_resolve, reject) => {
          const abort = () => {
            signalReceived = true;
            reject(
              new GitCommandError("GIT_ABORTED", "Git command was aborted."),
            );
          };
          if (options.signal?.aborted === true) {
            abort();
          } else {
            options.signal?.addEventListener("abort", abort, { once: true });
          }
        });
      },
      async tryRun() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as unknown as GitClient;
    const controller = new AbortController();
    const build = buildSnapshotPair("/repo", git, controller.signal);
    await baselineBlobReadStarted;
    controller.abort();

    await expect(build).rejects.toMatchObject({ code: "GIT_ABORTED" });
    expect(signalReceived).toBe(true);
    expect(await pathExists(snapshotRootFailure.temporaryParent)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "preserves a safe construction failure and validated path when construction cleanup also fails",
    async () => {
      const rawFailure =
        "RAW-CONSTRUCTION-FAILURE /private/unsafe/repository/path";
      const git = {
        async run(args: readonly string[]) {
          if (args[1] === "--stage") {
            return { stdout: stagedRecord(), stderr: "", exitCode: 0 };
          }
          if (args[1] === "--debug") {
            return { stdout: debugRecord(), stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async runBytes() {
          await chmod(snapshotRootFailure.temporaryParent, 0o500);
          throw new Error(rawFailure);
        },
        async tryRun() {
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      } as unknown as GitClient;
      onTestFinished(async () => {
        await chmod(snapshotRootFailure.temporaryParent, 0o700).catch(
          () => undefined,
        );
        await rm(snapshotRootFailure.temporaryParent, {
          recursive: true,
          force: true,
        });
      });

      let failure: unknown;
      try {
        await buildSnapshotPair("/repo", git);
      } catch (error) {
        failure = error;
      }
      const canonicalSnapshotRoot = await realpath(
        snapshotRootFailure.temporaryParent,
      );

      expect(failure).toMatchObject({
        name: "SnapshotConstructionCleanupError",
        constructionError: {
          code: "SNAPSHOT_CONSTRUCTION_FAILED",
        },
        temporaryPath: canonicalSnapshotRoot,
      });
      expect(String(failure)).not.toContain(rawFailure);
      expect(JSON.stringify(failure)).not.toContain(rawFailure);
    },
  );

  it.runIf(process.platform !== "win32")(
    "omits an unreportable path when construction cleanup finds changed identity",
    async () => {
      let movedSnapshotRoot: string | undefined;
      const rawFailure =
        "RAW-CONSTRUCTION-IDENTITY-FAILURE /private/unsafe/path";
      const git = {
        async run(args: readonly string[]) {
          if (args[1] === "--stage") {
            return { stdout: stagedRecord(), stderr: "", exitCode: 0 };
          }
          if (args[1] === "--debug") {
            return { stdout: debugRecord(), stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async runBytes() {
          movedSnapshotRoot = `${snapshotRootFailure.temporaryParent}-moved`;
          await rename(snapshotRootFailure.temporaryParent, movedSnapshotRoot);
          await symlink(
            movedSnapshotRoot,
            snapshotRootFailure.temporaryParent,
            "dir",
          );
          throw new Error(rawFailure);
        },
        async tryRun() {
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      } as unknown as GitClient;
      onTestFinished(async () => {
        await rm(snapshotRootFailure.temporaryParent, { force: true });
        if (movedSnapshotRoot !== undefined) {
          await rm(movedSnapshotRoot, { recursive: true, force: true });
        }
      });

      let failure: unknown;
      try {
        await buildSnapshotPair("/repo", git);
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        name: "SnapshotConstructionCleanupError",
        constructionError: {
          code: "SNAPSHOT_CONSTRUCTION_FAILED",
        },
      });
      expect(
        (failure as { temporaryPath?: string }).temporaryPath,
      ).toBeUndefined();
      const serialized = `${String(failure)}${JSON.stringify(failure)}`;
      expect(serialized).not.toContain(rawFailure);
      expect(serialized).not.toContain(snapshotRootFailure.temporaryParent);
      expect(serialized).not.toContain(movedSnapshotRoot);
    },
  );

  it("rejects unresolved index stages", async () => {
    const repository = await createGitRepository();
    await repository.write("conflict.ts", "export const side = 'base';\n");
    await repository.commitAll("base");
    await repository.git(["checkout", "-b", "other"]);
    await repository.write("conflict.ts", "export const side = 'other';\n");
    await repository.commitAll("other");
    await repository.git(["checkout", "main"]);
    await repository.write("conflict.ts", "export const side = 'main';\n");
    await repository.commitAll("main");
    const merge = await repository.git(["merge", "other"]);
    expect(merge.exitCode).not.toBe(0);

    await expect(
      buildSnapshotPair(repository.root, new GitClient(repository.root)),
    ).rejects.toMatchObject({ code: "UNRESOLVED_INDEX" });
  });

  it.each(["../outside.ts", "/absolute/outside.ts", ""])(
    "rejects an invalid staged path before checkout-index: %j",
    async (invalidPath) => {
      const calls: readonly string[][] = [];
      const mutableCalls = calls as string[][];
      const git = {
        async run(args: readonly string[]) {
          mutableCalls.push([...args]);
          if (args[0] === "ls-files" && args[1] === "--stage") {
            return {
              stdout: `100644 0123456789012345678901234567890123456789 0\t${invalidPath}\0`,
              stderr: "",
              exitCode: 0,
            };
          }
          if (args[0] === "checkout-index") {
            throw new Error("checkout-index must not receive an invalid path");
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async tryRun() {
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      } as unknown as GitClient;

      await expect(buildSnapshotPair("/repo", git)).rejects.toMatchObject({
        code: "INVALID_INDEX_PATH",
      });
      expect(
        mutableCalls.some(([command]) => command === "checkout-index"),
      ).toBe(false);
    },
  );

  it("rejects malformed staged-entry output before checkout", async () => {
    const calls: string[][] = [];
    const git = {
      async run(args: readonly string[]) {
        calls.push([...args]);
        if (args[0] === "ls-files" && args[1] === "--stage") {
          return {
            stdout:
              "100644 0123456789012345678901234567890123456789 0\tvalid.ts",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async tryRun() {
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    } as unknown as GitClient;

    await expect(buildSnapshotPair("/repo", git)).rejects.toMatchObject({
      code: "INVALID_INDEX_PATH",
    });
    expect(calls.some(([command]) => command === "checkout-index")).toBe(false);
  });

  it("records submodule gitlinks as unsupported index entries", async () => {
    const repository = await createGitRepository();
    await repository.write("root.ts", "export const root = true;\n");
    await repository.commitAll("root");
    const head = await repository.git(["rev-parse", "HEAD"]);
    await repository.git([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head.stdout},vendor/demo`,
    ]);

    const snapshots = await buildSnapshotPair(
      repository.root,
      new GitClient(repository.root),
    );
    onTestFinished(snapshots.cleanup);

    expect(snapshots.unsupportedEntries).toContainEqual({
      path: "vendor/demo",
      kind: "submodule",
    });
  });

  it("records LFS pointers and binary files without exposing their contents", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "large.dat",
      "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 42\n",
    );
    await writeFile(
      join(repository.root, "binary.dat"),
      Buffer.from([0x7a, 0x00, 0x62]),
    );
    await repository.git(["add", "--", "large.dat", "binary.dat"]);

    const snapshots = await buildSnapshotPair(
      repository.root,
      new GitClient(repository.root),
    );
    onTestFinished(snapshots.cleanup);

    expect(snapshots.unsupportedEntries).toEqual([
      { path: "binary.dat", kind: "binary" },
      { path: "large.dat", kind: "git-lfs-pointer" },
    ]);
  });

  it("removes intent-to-add placeholders from the target snapshot", async () => {
    const repository = await createGitRepository();
    await repository.write("intent.ts", "export const future = true;\n");
    await repository.git(["add", "--intent-to-add", "--", "intent.ts"]);

    const snapshots = await buildSnapshotPair(
      repository.root,
      new GitClient(repository.root),
    );
    onTestFinished(snapshots.cleanup);

    expect(await pathExists(join(snapshots.targetDir, "intent.ts"))).toBe(
      false,
    );
    expect(snapshots.unsupportedEntries).toEqual([]);
  });

  it("removes a deleted intent-to-add placeholder while preserving staged source", async () => {
    const repository = await createGitRepository();
    await repository.write("package.json", '{"name":"fixture"}\n');
    await repository.commitAll("base");
    await repository.write("normal.ts", "export const staged = true;\n");
    await repository.write("intent.ts", "export const unstaged = true;\n");
    await repository.git(["add", "--", "normal.ts"]);
    await repository.git(["add", "--intent-to-add", "--", "intent.ts"]);
    await rm(join(repository.root, "intent.ts"));

    const snapshots = await buildSnapshotPair(
      repository.root,
      new GitClient(repository.root),
    );
    onTestFinished(snapshots.cleanup);
    const inspection = await inspectRepository(snapshots.targetDir);

    expect(await readFile(join(snapshots.targetDir, "normal.ts"), "utf8")).toBe(
      "export const staged = true;\n",
    );
    expect(await pathExists(join(snapshots.targetDir, "intent.ts"))).toBe(
      false,
    );
    expect(
      inspection.workspaces.flatMap(({ sourceFiles }) => sourceFiles),
    ).toEqual(["normal.ts"]);
    expect(snapshots.unsupportedEntries).toEqual([]);
  });
});

describe("buildCommitSnapshotPair", () => {
  it("materializes exact committed trees without changing a dirty index or working tree", async () => {
    const repository = await createGitRepository();
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.commitAll("baseline");
    const baselineCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;

    await repository.write("src/value.ts", "export const value = 2;\n");
    await repository.write("target-only.ts", "export const target = true;\n");
    await repository.commitAll("target");
    const targetCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;

    await repository.write("src/value.ts", "export const value = 3;\n");
    await repository.git(["add", "--", "src/value.ts"]);
    await repository.write("src/value.ts", "export const value = 4;\n");
    await repository.write("working-only.ts", "export const working = true;\n");
    const beforeIndex = await repository.git(["write-tree"]);
    const beforeHead = await repository.git(["rev-parse", "HEAD"]);

    const pair = await buildCommitSnapshotPair(
      repository.root,
      new GitClient(repository.root),
      baselineCommit,
      targetCommit,
    );
    onTestFinished(pair.cleanup);

    expect(pair.baselineRef).toBe(baselineCommit);
    expect(pair.targetRef).toBe(targetCommit);
    expect(await readFile(join(pair.baselineDir, "src/value.ts"), "utf8")).toBe(
      "export const value = 1;\n",
    );
    expect(await readFile(join(pair.targetDir, "src/value.ts"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    expect(await pathExists(join(pair.targetDir, "target-only.ts"))).toBe(true);
    expect(await pathExists(join(pair.targetDir, "working-only.ts"))).toBe(
      false,
    );
    expect(await repository.read("src/value.ts")).toBe(
      "export const value = 4;\n",
    );

    await pair.cleanup();
    expect((await repository.git(["write-tree"])).stdout).toBe(
      beforeIndex.stdout,
    );
    expect((await repository.git(["rev-parse", "HEAD"])).stdout).toBe(
      beforeHead.stdout,
    );
  });

  it("classifies target commit submodules, LFS pointers, and binary files", async () => {
    const repository = await createGitRepository();
    await repository.write("base.ts", "export const base = true;\n");
    await repository.commitAll("baseline");
    const baselineCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;

    await repository.write(
      "large.dat",
      "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 42\n",
    );
    await writeFile(
      join(repository.root, "binary.dat"),
      Buffer.from([0x7a, 0x00, 0x62]),
    );
    await repository.git(["add", "--", "large.dat", "binary.dat"]);
    await repository.git([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${baselineCommit},vendor/demo`,
    ]);
    await repository.git(["commit", "--message", "target unsupported inputs"]);
    const targetCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;

    const pair = await buildCommitSnapshotPair(
      repository.root,
      new GitClient(repository.root),
      baselineCommit,
      targetCommit,
    );
    onTestFinished(pair.cleanup);

    expect(pair.unsupportedEntries).toEqual([
      { path: "binary.dat", kind: "binary" },
      { path: "large.dat", kind: "git-lfs-pointer" },
      { path: "vendor/demo", kind: "submodule" },
    ]);
  });

  it("rejects invalid commit-tree paths before reading blobs", async () => {
    const calls: string[][] = [];
    const git = {
      async run(args: readonly string[]) {
        calls.push([...args]);
        if (args[0] === "ls-tree") {
          return {
            stdout:
              "100644 blob 0123456789012345678901234567890123456789\t../outside.ts\0",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async runBytes(args: readonly string[]) {
        calls.push([...args]);
        throw new Error("cat-file must not receive an invalid path");
      },
    } as unknown as GitClient;

    await expect(
      buildCommitSnapshotPair("/repo", git, "baseline-oid", "target-oid"),
    ).rejects.toMatchObject({ code: "INVALID_INDEX_PATH" });
    expect(calls.some(([command]) => command === "cat-file")).toBe(false);
  });

  it("cleans its temporary root after commit snapshot construction fails", async () => {
    const git = {
      async run(args: readonly string[]) {
        if (args[0] === "ls-tree") {
          return { stdout: treeRecord(), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async runBytes() {
        throw new Error("commit snapshot construction failure");
      },
    } as unknown as GitClient;

    await expect(
      buildCommitSnapshotPair("/repo", git, "baseline-oid", "target-oid"),
    ).rejects.toThrow("commit snapshot construction failure");
    expect(await pathExists(snapshotRootFailure.temporaryParent)).toBe(false);
  });

  it("aborts a commit blob read and removes its temporary root", async () => {
    let signalReceived = false;
    let beginBlobRead: (() => void) | undefined;
    const blobReadStarted = new Promise<void>((resolve) => {
      beginBlobRead = resolve;
    });
    const git = {
      async run(args: readonly string[]) {
        if (args[0] === "ls-tree") {
          return { stdout: treeRecord(), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async runBytes(
        _args: readonly string[],
        options: { signal?: AbortSignal } = {},
      ) {
        beginBlobRead?.();
        return new Promise<never>((_resolve, reject) => {
          const abort = () => {
            signalReceived = true;
            reject(
              new GitCommandError("GIT_ABORTED", "Git command was aborted."),
            );
          };
          options.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    } as unknown as GitClient;
    const controller = new AbortController();
    const build = buildCommitSnapshotPair(
      "/repo",
      git,
      "baseline-oid",
      "target-oid",
      controller.signal,
    );
    await blobReadStarted;
    controller.abort();

    await expect(build).rejects.toMatchObject({ code: "GIT_ABORTED" });
    expect(signalReceived).toBe(true);
    expect(await pathExists(snapshotRootFailure.temporaryParent)).toBe(false);
  });
});
