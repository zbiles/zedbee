import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitClient } from "../../src/git/client.js";
import { captureWorkingTreeRegistry } from "../../src/inspection/working-tree-registry.js";
import { createInspectionFixture } from "./fixture.js";

function filePaths(
  registry: Awaited<ReturnType<typeof captureWorkingTreeRegistry>>,
): string[] {
  return registry
    .entries()
    .filter((entry) => entry.targetKind === "file")
    .map((entry) => entry.repositoryPath)
    .sort();
}

describe("captureWorkingTreeRegistry", () => {
  it.each(["file", "repository directory"])(
    "rejects nonignored external symlinks to a %s",
    async (kind) => {
      const fixture = await createInspectionFixture();
      const outside = await createInspectionFixture();
      await new GitClient(fixture.root).run(["init"]);
      await outside.write("package.json", "{}");
      if (kind === "repository directory")
        await new GitClient(outside.root).run(["init"]);
      await fixture.symlink(
        kind === "file" ? join(outside.root, "package.json") : outside.root,
        "external",
      );

      await expect(
        captureWorkingTreeRegistry(fixture.root),
      ).rejects.toMatchObject({ code: "UNSAFE_SNAPSHOT_PATH" });
    },
  );

  it("retains symlink aliases to selected repository files", async () => {
    const fixture = await createInspectionFixture();
    await new GitClient(fixture.root).run(["init"]);
    await fixture.write("shared/package.json", "{}");
    await fixture.symlink("../shared/package.json", "web/package.json");

    const registry = await captureWorkingTreeRegistry(fixture.root);

    expect(registry.resolve("web/package.json")?.kind).toBe("symlink");
    expect(registry.resolve("shared/package.json")?.targetKind).toBe("file");
  });

  it.each(["ignored", "nested"])(
    "does not register symlink aliases into %s checkout files",
    async (kind) => {
      const fixture = await createInspectionFixture();
      await new GitClient(fixture.root).run(["init"]);
      await fixture.write("web/package.json", "{}");
      await fixture.write("copies/old/package.json", "{}");
      if (kind === "ignored") await fixture.write(".gitignore", "copies/\n");
      else
        await fixture.write(
          "copies/old/.git",
          "gitdir: /outside/old-worktree\n",
        );
      await fixture.symlink("../copies/old/package.json", "alias/package.json");

      const registry = await captureWorkingTreeRegistry(fixture.root);

      expect(registry.resolve("copies/old/package.json")).toBeUndefined();
      expect(registry.resolve("alias/package.json")).toBeUndefined();
      expect(registry.resolve("web/package.json")?.targetKind).toBe("file");
    },
  );

  it("keeps tracked ignored files and nonignored untracked files while excluding ignored local files", async () => {
    const fixture = await createInspectionFixture();
    const git = new GitClient(fixture.root);
    await git.run(["init"]);
    await fixture.write("tracked/package.json", "{}");
    await git.run(["add", "tracked/package.json"]);
    await fixture.write(".gitignore", "tracked/\nlocal/\nnode_modules/\n");
    await fixture.write("local/package.json", "{}");
    await fixture.write("tracked/local.json", "{}");
    await fixture.write("node_modules/prettier/package.json", "{}");
    await fixture.write("web\napp/package.json", "{}");

    expect(filePaths(await captureWorkingTreeRegistry(fixture.root))).toEqual([
      ".gitignore",
      "tracked/package.json",
      "web\napp/package.json",
    ]);
  });

  it("reads files from a linked working tree whose own .git marker is a file", async () => {
    const fixture = await createInspectionFixture();
    const target = await createInspectionFixture();
    const git = new GitClient(fixture.root);
    await git.run(["init"]);
    await fixture.write("package.json", "{}");
    await git.run(["add", "."]);
    await git.run([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "fixture",
    ]);
    const worktree = join(target.root, "linked");
    await git.run(["worktree", "add", "--detach", worktree]);

    const registry = await captureWorkingTreeRegistry(worktree);
    expect(registry.snapshotRoot).toBe(await realpath(worktree));
    expect(filePaths(registry)).toEqual(["package.json"]);
  });

  it("does not fall back to a full walk when repository metadata is invalid", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write(".git", "gitdir: /missing/zedbee-worktree\n");
    await fixture.write("ignored/package.json", "{}");

    await expect(captureWorkingTreeRegistry(fixture.root)).rejects.toThrow();
  });

  it("retains filesystem discovery for unpacked projects without Git metadata", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("web/package.json", "{}");
    await fixture.write("node_modules/prettier/package.json", "{}");

    expect(filePaths(await captureWorkingTreeRegistry(fixture.root))).toEqual([
      "web/package.json",
    ]);
  });
});
