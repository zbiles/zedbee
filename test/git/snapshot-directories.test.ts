import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createSnapshotDirectories } from "../../src/git/snapshot-directories.js";

const calls = vi.hoisted(() => ({ mkdir: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      calls.mkdir++;
      return actual.mkdir(...args);
    },
  };
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zedbee-directory-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

describe("snapshot directory creation", () => {
  it("creates common parents once across concurrent writes", async () => {
    const root = await fixture();
    const directories = createSnapshotDirectories(root);
    calls.mkdir = 0;
    await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        directories.ensure(`src/deep/file-${i}.ts`),
      ),
    );
    expect(calls.mkdir).toBe(2);
  });
  it.each(["directory", "symlink"])(
    "rejects an established parent replaced by another %s",
    async (kind) => {
      const root = await fixture();
      const directories = createSnapshotDirectories(root);
      await directories.ensure("src/deep/first.ts");
      await rename(join(root, "src"), join(root, "old"));
      if (kind === "symlink")
        await symlink(
          join(root, "old"),
          join(root, "src"),
          process.platform === "win32" ? "junction" : "dir",
        );
      else await mkdir(join(root, "src"));
      await expect(
        directories.ensure("src/deep/next.ts"),
      ).rejects.toMatchObject({ code: "INVALID_TEMP_PATH" });
    },
  );
  it("retains a failed parent promise and rejects every affected writer", async () => {
    const root = await fixture();
    const directories = createSnapshotDirectories(root);
    await symlink(
      root,
      join(root, "unsafe"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await Promise.allSettled([
      directories.ensure("unsafe/a.ts"),
      directories.ensure("unsafe/b.ts"),
    ]);
    expect(result.map((entry) => entry.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    await rm(join(root, "unsafe"));
    await expect(directories.ensure("unsafe/c.ts")).rejects.toMatchObject({
      code: "INVALID_TEMP_PATH",
    });
  });
});
