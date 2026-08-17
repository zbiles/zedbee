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
import { describe, expect, it, onTestFinished } from "vitest";
import { sanitizeCheckResult } from "../../src/checks/sanitize-result.js";
import type { CheckResult } from "../../src/core/types.js";
import { GitClient } from "../../src/git/client.js";
import { buildSnapshotPair } from "../../src/git/snapshot.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import {
  validateReportableSnapshotPath,
  validateSnapshotPath,
} from "../../src/git/snapshot-path.js";
import { createGitRepository } from "../helpers/git-repository.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("buildSnapshotPair", () => {
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

  it.runIf(process.platform !== "win32")(
    "preserves a safe construction failure and validated path when construction cleanup also fails",
    async () => {
      let snapshotRoot: string | undefined;
      const rawFailure =
        "RAW-CONSTRUCTION-FAILURE /private/unsafe/repository/path";
      const git = {
        async run(args: readonly string[]) {
          if (args[0] === "checkout-index") {
            const prefix = args.find((arg) => arg.startsWith("--prefix="))!;
            const targetDir = prefix
              .slice("--prefix=".length)
              .replace(/[/\\]+$/u, "");
            snapshotRoot = dirname(targetDir);
            await chmod(snapshotRoot, 0o500);
            throw new Error(rawFailure);
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async tryRun() {
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      } as unknown as GitClient;
      onTestFinished(async () => {
        if (snapshotRoot !== undefined) {
          await chmod(snapshotRoot, 0o700).catch(() => undefined);
          await rm(snapshotRoot, { recursive: true, force: true });
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
        temporaryPath: snapshotRoot,
      });
      expect(String(failure)).not.toContain(rawFailure);
      expect(JSON.stringify(failure)).not.toContain(rawFailure);
    },
  );

  it.runIf(process.platform !== "win32")(
    "omits an unreportable path when construction cleanup finds changed identity",
    async () => {
      let snapshotRoot: string | undefined;
      let movedSnapshotRoot: string | undefined;
      const rawFailure =
        "RAW-CONSTRUCTION-IDENTITY-FAILURE /private/unsafe/path";
      const git = {
        async run(args: readonly string[]) {
          if (args[0] === "checkout-index") {
            const prefix = args.find((arg) => arg.startsWith("--prefix="))!;
            const targetDir = prefix
              .slice("--prefix=".length)
              .replace(/[/\\]+$/u, "");
            snapshotRoot = dirname(targetDir);
            movedSnapshotRoot = `${snapshotRoot}-moved`;
            await rename(snapshotRoot, movedSnapshotRoot);
            await symlink(movedSnapshotRoot, snapshotRoot, "dir");
            throw new Error(rawFailure);
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async tryRun() {
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      } as unknown as GitClient;
      onTestFinished(async () => {
        if (snapshotRoot !== undefined) {
          await rm(snapshotRoot, { force: true });
        }
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
      expect(serialized).not.toContain(snapshotRoot);
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
