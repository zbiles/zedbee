import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createProjectWorkspace } from "../../../src/checks/prettier/project-workspace.js";

async function snapshotFixture(): Promise<{
  root: string;
  dependency: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-workspace-snapshot-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");
  const dependency = await mkdtemp(join(tmpdir(), "zedbee-workspace-dep-"));
  onTestFinished(() => rm(dependency, { recursive: true, force: true }));
  await mkdir(join(dependency, "prettier"), { recursive: true });
  await writeFile(
    join(dependency, "prettier", "package.json"),
    '{"name":"prettier","version":"3.9.6"}\n',
  );
  return { root, dependency };
}

describe("project Prettier workspace", () => {
  it("mirrors snapshot bytes into an independent file", async () => {
    const { root, dependency } = await snapshotFixture();
    const workspace = await createProjectWorkspace(
      {
        snapshotRoot: root,
        projectRoot: ".",
        dependencyRoots: [
          { relativePath: "node_modules", absolutePath: dependency },
        ],
      },
      new AbortController().signal,
    );
    onTestFinished(() => workspace.dispose());

    const source = await lstat(join(root, "src", "value.ts"));
    const copiedPath = join(workspace.treeRoot, "src", "value.ts");
    const copied = await lstat(copiedPath);
    expect(await readFile(copiedPath, "utf8")).toBe(
      "export const value = 1;\n",
    );
    expect(copied.ino).not.toBe(source.ino);
    expect(
      await lstat(join(workspace.treeRoot, "node_modules")),
    ).toBeDefined();
  });

  it("cleans only its own directory", async () => {
    const { root, dependency } = await snapshotFixture();
    const workspace = await createProjectWorkspace({
      snapshotRoot: root,
      projectRoot: ".",
      dependencyRoots: [
        { relativePath: "node_modules", absolutePath: dependency },
      ],
    });
    const workspaceRoot = workspace.root;
    const sentinel = await mkdtemp(join(tmpdir(), "zedbee-workspace-sentinel-"));
    onTestFinished(() => rm(sentinel, { recursive: true, force: true }));
    await writeFile(join(sentinel, "keep.txt"), "keep");

    await workspace.dispose();

    await expect(lstat(workspaceRoot)).rejects.toThrow();
    expect(await readFile(join(sentinel, "keep.txt"), "utf8")).toBe("keep");
  });
});
