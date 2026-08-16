import {
  access,
  chmod,
  lstat,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { GitClient } from "../../src/git/client.js";
import { buildSnapshotPair } from "../../src/git/snapshot.js";
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
  it("materializes HEAD and the index without observing later working-tree edits", async () => {
    const repository = await createGitRepository();
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.commitAll("initial");

    await repository.write("src/value.ts", "export const value = 2;\n");
    await repository.git(["add", "--", "src/value.ts"]);
    await repository.write("src/value.ts", "export const value = 3;\n");

    const beforeStatus = await repository.git(["status", "--porcelain=v1", "-z"]);
    const beforeIndex = await readFile(join(repository.root, ".git", "index"));
    const snapshots = await buildSnapshotPair(repository.root, new GitClient(repository.root));
    onTestFinished(snapshots.cleanup);

    expect(await readFile(join(snapshots.baselineDir, "src/value.ts"), "utf8")).toBe(
      "export const value = 1;\n"
    );
    expect(await readFile(join(snapshots.targetDir, "src/value.ts"), "utf8")).toBe(
      "export const value = 2;\n"
    );
    expect(await repository.read("src/value.ts")).toBe("export const value = 3;\n");

    await snapshots.cleanup();
    const afterStatus = await repository.git(["status", "--porcelain=v1", "-z"]);
    const afterIndex = await readFile(join(repository.root, ".git", "index"));
    expect(afterStatus.stdout).toBe(beforeStatus.stdout);
    expect(afterIndex).toEqual(beforeIndex);
  });

  it("uses an empty baseline for an initial commit", async () => {
    const repository = await createGitRepository();
    await repository.write("new.ts", "export const created = true;\n");
    await repository.git(["add", "--", "new.ts"]);

    const snapshots = await buildSnapshotPair(repository.root, new GitClient(repository.root));
    onTestFinished(snapshots.cleanup);

    expect(snapshots.baselineRef).toBeNull();
    expect(await readdir(snapshots.baselineDir)).toEqual([]);
    expect(await readFile(join(snapshots.targetDir, "new.ts"), "utf8")).toContain(
      "created = true"
    );
  });

  it("represents additions, deletions, renames, modes, and paths with spaces", async () => {
    const repository = await createGitRepository();
    await repository.write("delete.ts", "export const removed = true;\n");
    await repository.write("rename-old.ts", "export const renamed = true;\n");
    await repository.write("script.sh", "#!/bin/sh\nexit 0\n");
    await repository.commitAll("initial shapes");

    await rm(join(repository.root, "delete.ts"));
    await repository.git(["mv", "rename-old.ts", "rename new.ts"]);
    await repository.write("path with spaces.ts", "export const spaced = true;\n");
    await chmod(join(repository.root, "script.sh"), 0o755);
    await repository.git(["add", "--all"]);

    const snapshots = await buildSnapshotPair(repository.root, new GitClient(repository.root));
    onTestFinished(snapshots.cleanup);

    expect(await pathExists(join(snapshots.baselineDir, "delete.ts"))).toBe(true);
    expect(await pathExists(join(snapshots.targetDir, "delete.ts"))).toBe(false);
    expect(await pathExists(join(snapshots.baselineDir, "rename-old.ts"))).toBe(true);
    expect(await pathExists(join(snapshots.targetDir, "rename-old.ts"))).toBe(false);
    expect(await pathExists(join(snapshots.targetDir, "rename new.ts"))).toBe(true);
    expect(await pathExists(join(snapshots.targetDir, "path with spaces.ts"))).toBe(true);
    if (process.platform !== "win32") {
      expect((await lstat(join(snapshots.targetDir, "script.sh"))).mode & 0o111).not.toBe(0);
    }
  });

  it.runIf(process.platform !== "win32")("preserves staged symbolic links", async () => {
    const repository = await createGitRepository();
    await repository.write("target.txt", "target\n");
    await symlink("target.txt", join(repository.root, "link.txt"));
    await repository.git(["add", "--", "target.txt", "link.txt"]);

    const snapshots = await buildSnapshotPair(repository.root, new GitClient(repository.root));
    onTestFinished(snapshots.cleanup);

    expect((await lstat(join(snapshots.targetDir, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(snapshots.targetDir, "link.txt"), "utf8")).toBe("target\n");
  });

  it("cleans only its temporary parent and cleanup is idempotent", async () => {
    const repository = await createGitRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "value.ts"]);
    const snapshots = await buildSnapshotPair(repository.root, new GitClient(repository.root));
    const temporaryParent = join(snapshots.targetDir, "..");

    await snapshots.cleanup();
    await snapshots.cleanup();

    expect(await pathExists(temporaryParent)).toBe(false);
    expect(await pathExists(repository.root)).toBe(true);
  });

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
      buildSnapshotPair(repository.root, new GitClient(repository.root))
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
      `160000,${head.stdout},vendor/demo`
    ]);

    const snapshots = await buildSnapshotPair(repository.root, new GitClient(repository.root));
    onTestFinished(snapshots.cleanup);

    expect(snapshots.unsupportedEntries).toContainEqual({
      path: "vendor/demo",
      kind: "submodule"
    });
  });

  it("records LFS pointers and binary files without exposing their contents", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "large.dat",
      "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 42\n"
    );
    await writeFile(join(repository.root, "binary.dat"), Buffer.from([0x7a, 0x00, 0x62]));
    await repository.git(["add", "--", "large.dat", "binary.dat"]);

    const snapshots = await buildSnapshotPair(repository.root, new GitClient(repository.root));
    onTestFinished(snapshots.cleanup);

    expect(snapshots.unsupportedEntries).toEqual([
      { path: "binary.dat", kind: "binary" },
      { path: "large.dat", kind: "git-lfs-pointer" }
    ]);
  });

  it("records intent-to-add entries instead of treating empty index blobs as source", async () => {
    const repository = await createGitRepository();
    await repository.write("intent.ts", "export const future = true;\n");
    await repository.git(["add", "--intent-to-add", "--", "intent.ts"]);

    const snapshots = await buildSnapshotPair(repository.root, new GitClient(repository.root));
    onTestFinished(snapshots.cleanup);

    expect(snapshots.unsupportedEntries).toContainEqual({
      path: "intent.ts",
      kind: "intent-to-add"
    });
  });
});
