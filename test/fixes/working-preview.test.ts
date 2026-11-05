import { createHash } from "node:crypto";
import { copyFile, lstat, symlink, truncate } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitClient } from "../../src/git/client.js";
import type { BuildFixPlanDependencies } from "../../src/fixes/build-plan.js";
import type { CheckFixCandidate } from "../../src/fixes/types.js";
import {
  changedWorkingFiles,
  mapPreviewFiles,
  workingFilePreviews,
  WORKING_PREVIEW_CONCURRENCY,
  WORKING_PREVIEW_FILE_BYTES,
  WORKING_PREVIEW_TOTAL_BYTES,
} from "../../src/fixes/working-preview.js";
import { createGitRepository } from "../helpers/git-repository.js";

const signal = () => new AbortController().signal;
const candidate = (file: string): CheckFixCandidate => ({
  kind: "exact-file",
  checkId: "lint",
  file,
  baseSource: "x",
  edits: [],
});
const dependencies = {
  hasUnstagedChanges: async () => false,
} as unknown as BuildFixPlanDependencies;

describe("working-file preview capture", () => {
  it("ignores unrelated symlinks into excluded output directories", async () => {
    const repo = await createGitRepository();
    await repo.write("src/a.ts", "x");
    await repo.write("dist/generated/a.ts", "generated");
    await symlink("dist/generated", join(repo.root, "output"));
    const result = await workingFilePreviews(
      repo.root,
      [candidate("src/a.ts")],
      new GitClient(repo.root),
      signal(),
      dependencies,
    );
    expect([...result.keys()]).toEqual(["src/a.ts"]);
    expect(result.get("src/a.ts")?.content).toBe("x");
  });

  it("bounds concurrency and waits for all started tasks after failure", async () => {
    const files = Array.from({ length: 100 }, (_, index) => `${index}`);
    let active = 0;
    let maximum = 0;
    let started = 0;
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let returned = false;
    const result = mapPreviewFiles(files, signal(), async (file) => {
      started++;
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (file === "0") throw new Error("fixture failure");
        await blocked;
        return file;
      } finally {
        active--;
      }
    }).finally(() => {
      returned = true;
    });
    const assertion = expect(result).rejects.toThrow("fixture failure");
    await Promise.resolve();
    await Promise.resolve();
    expect(maximum).toBeLessThanOrEqual(WORKING_PREVIEW_CONCURRENCY);
    expect(returned).toBe(false);
    release();
    await assertion;
    expect(active).toBe(0);
    expect(started).toBe(WORKING_PREVIEW_CONCURRENCY);
  });

  it("settles active reads and stops scheduling when cancelled", async () => {
    const controller = new AbortController();
    let completed = 0;
    const read = vi.fn(async () => {
      controller.abort();
      await Promise.resolve();
      completed++;
      return "read";
    });
    await expect(
      mapPreviewFiles(
        Array.from({ length: 100 }, (_, i) => `${i}`),
        controller.signal,
        read,
      ),
    ).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
    expect(completed).toBe(1);
  });

  it("enforces per-file and aggregate byte budgets before loading source", async () => {
    const repo = await createGitRepository();
    await repo.write("large.ts", "");
    await truncate(join(repo.root, "large.ts"), WORKING_PREVIEW_FILE_BYTES + 1);
    await expect(
      workingFilePreviews(
        repo.root,
        [candidate("large.ts")],
        new GitClient(repo.root),
        signal(),
        dependencies,
      ),
    ).rejects.toThrow("source byte budget");
    const count = WORKING_PREVIEW_TOTAL_BYTES / WORKING_PREVIEW_FILE_BYTES + 1;
    const files = Array.from(
      { length: count },
      (_, index) => `files/${index}.ts`,
    );
    for (const file of files) {
      await repo.write(file, "");
      await truncate(join(repo.root, file), WORKING_PREVIEW_FILE_BYTES);
    }
    await expect(
      workingFilePreviews(
        repo.root,
        files.map(candidate),
        new GitClient(repo.root),
        signal(),
        dependencies,
      ),
    ).rejects.toThrow("source byte budget");
  });

  it("batches literal selected-index paths and streams each raw blob once", async () => {
    const objectId = "a".repeat(40);
    const run = vi.fn(async (args: readonly string[]) => ({
      stdout: args
        .slice(args.indexOf("--") + 1)
        .map((path) => `100644 ${objectId} 0\t${path.slice(10)}\0`)
        .join(""),
      stderr: "",
      exitCode: 0,
    }));
    const git = new GitClient("/unused", { runCommand: run });
    const stream = vi
      .spyOn(git, "streamBlobs")
      .mockImplementation(async (objects, visit) => {
        expect(objects).toEqual([objectId]);
        await visit({
          objectId,
          size: 4,
          chunks: (async function* () {
            yield Buffer.from("base");
          })(),
        });
      });
    const files = Array.from(
      { length: 1_000 },
      (_, index) => `src/${index}-long-file-name.ts`,
    );
    const sha256 = createHash("sha256").update("base").digest("hex");
    const previews = new Map(
      files.map(
        (path) =>
          [
            path,
            {
              path,
              content: "base",
              sha256,
              mode: 0o644,
              hasUnstagedChanges: false,
            },
          ] as const,
      ),
    );
    expect(await changedWorkingFiles(git, previews, signal())).toEqual(
      new Set(),
    );
    expect(run.mock.calls.length).toBeGreaterThan(1);
    expect(run.mock.calls.length).toBeLessThan(4);
    expect(stream).toHaveBeenCalledTimes(1);
    for (const [args] of run.mock.calls) {
      expect(args).toEqual(
        expect.arrayContaining(["ls-files", "--stage", "-z"]),
      );
      expect(args).not.toContain("diff");
      const paths = args.slice(args.indexOf("--") + 1);
      expect(paths.every((file) => file.startsWith(":(literal)"))).toBe(true);
    }
  });

  it("does not run a clean filter selected by working-tree attributes", async () => {
    const repo = await createGitRepository();
    await repo.write("a.ts", "base\n");
    await repo.commitAll("base");
    const index = join(repo.root, ".git", "captured-index");
    await copyFile(join(repo.root, ".git", "index"), index);
    const marker = join(repo.root, "clean-filter-ran");
    await repo.write(
      "clean.cjs",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');process.stdin.pipe(process.stdout);`,
    );
    await repo.git([
      "config",
      "filter.review.clean",
      `${process.execPath} ${join(repo.root, "clean.cjs")}`,
    ]);
    await repo.write(".gitattributes", "*.ts filter=review\n");
    await repo.write("a.ts", "working bytes\n");
    const git = new GitClient(repo.root).withSelectedIndex(
      index,
      "HEAD",
      "HEAD",
    );
    const previews = await workingFilePreviews(
      repo.root,
      [candidate("a.ts")],
      git,
      signal(),
      { changedWorkingFiles },
    );
    expect(previews.get("a.ts")?.hasUnstagedChanges).toBe(true);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // Prove this fixture would execute even with the previous inert diff flags.
    await repo.git([
      "diff",
      "--no-textconv",
      "--no-ext-diff",
      "--name-only",
      "--",
      "a.ts",
    ]);
    expect((await lstat(marker)).isFile()).toBe(true);
  });

  it("compares the captured index and never runs an installed textconv driver", async () => {
    const repo = await createGitRepository();
    await repo.write("a.ts", "base\n");
    await repo.write(".gitattributes", "*.ts diff=probe\n");
    await repo.commitAll("base");
    const index = join(repo.root, ".git", "captured-index");
    await copyFile(join(repo.root, ".git", "index"), index);
    const marker = join(repo.root, "driver-ran");
    await repo.write(
      "converter.cjs",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');process.stdout.write('converted');`,
    );
    await repo.git([
      "config",
      "diff.probe.textconv",
      `${process.execPath} ${join(repo.root, "converter.cjs")}`,
    ]);
    await repo.write("a.ts", "later staged\n");
    await repo.git(["add", "a.ts"]);
    const git = new GitClient(repo.root).withSelectedIndex(
      index,
      "HEAD",
      "HEAD",
    );
    const captured = await workingFilePreviews(
      repo.root,
      [candidate("a.ts")],
      git,
      signal(),
      { changedWorkingFiles },
    );
    expect(captured.get("a.ts")?.hasUnstagedChanges).toBe(true);
    const live = await workingFilePreviews(
      repo.root,
      [candidate("a.ts")],
      new GitClient(repo.root),
      signal(),
      { changedWorkingFiles },
    );
    expect(live.get("a.ts")?.hasUnstagedChanges).toBe(false);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
