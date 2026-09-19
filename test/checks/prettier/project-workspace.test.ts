import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createProjectWorkspace,
  ProjectWorkspaceLayoutError,
} from "../../../src/checks/prettier/project-workspace.js";
import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repositoryPackageRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function snapshotFixture(): Promise<{
  root: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-workspace-snapshot-"));
  const cleanup = () => rm(root, { recursive: true, force: true });
  onTestFinished(cleanup);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "value.ts"),
    "export const value = 1;\n",
  );
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "fixture",
      private: true,
      devDependencies: { prettier: "^3.0.0" },
    })}\n`,
  );
  return { root, cleanup };
}

describe("project Prettier workspace", () => {
  it("mirrors snapshot bytes into an independent file and links declared roots only", async () => {
    const { root } = await snapshotFixture();
    const repositoryRoot = await mkdtemp(join(tmpdir(), "zedbee-workspace-repo-"));
    onTestFinished(() => rm(repositoryRoot, { recursive: true, force: true }));
    // An undeclared transitive copy must not be linked into the mirror.
    await mkdir(join(repositoryRoot, "node_modules", "undeclared-pkg"), {
      recursive: true,
    });
    await writeFile(
      join(repositoryRoot, "node_modules", "undeclared-pkg", "package.json"),
      '{"name":"undeclared-pkg"}',
    );
    await cp(
      join(repositoryPackageRoot, "node_modules", "prettier"),
      join(repositoryRoot, "node_modules", "prettier"),
      { recursive: true },
    );

    const workspace = await createProjectWorkspace(
      {
        repositoryRoot,
        snapshotRoot: root,
        projectRoot: ".",
      },
      new AbortController().signal,
    );
    onTestFinished(() => workspace.dispose());

    const source = await lstat(join(root, "src", "value.ts"));
    const copiedPath = join(workspace.treeRoot, "src", "value.ts");
    const copied = await lstat(copiedPath);
    expect(await readFile(copiedPath, "utf8")).toBe("export const value = 1;\n");
    expect(copied.ino).not.toBe(source.ino);
    expect(
      (await lstat(join(workspace.treeRoot, "node_modules", "prettier"))).isSymbolicLink(),
    ).toBe(true);
    await expect(
      lstat(join(workspace.treeRoot, "node_modules", "undeclared-pkg")),
    ).rejects.toThrow();
  });

  it("remaps a tracked workspace dependency to its snapshot copy", async () => {
    const snapshotRoot = await mkdtemp(join(tmpdir(), "zedbee-workspace-ws-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "zedbee-workspace-wsrepo-"));
    onTestFinished(async () => {
      await rm(snapshotRoot, { recursive: true, force: true });
      await rm(repositoryRoot, { recursive: true, force: true });
    });
    const manifest = `${JSON.stringify({
      name: "fixture",
      private: true,
      workspaces: ["packages/*"],
      devDependencies: { "fixture-plugin": "*", prettier: "^3.0.0" },
    })}\n`;
    await writeFile(join(snapshotRoot, "package.json"), manifest);
    await writeFile(join(repositoryRoot, "package.json"), manifest);
    await mkdir(join(snapshotRoot, "packages", "fixture-plugin"), {
      recursive: true,
    });
    await writeFile(
      join(snapshotRoot, "packages", "fixture-plugin", "package.json"),
      '{"name":"fixture-plugin","version":"1.0.0"}',
    );
    await mkdir(join(repositoryRoot, "packages", "fixture-plugin"), {
      recursive: true,
    });
    // The live workspace package differs from the snapshot; the mirror must
    // expose the snapshot copy, never these live bytes.
    await writeFile(
      join(repositoryRoot, "packages", "fixture-plugin", "package.json"),
      '{"name":"fixture-plugin","version":"2.0.0-live"}',
    );
    await mkdir(join(repositoryRoot, "node_modules"), { recursive: true });
    await symlink(
      join(repositoryRoot, "packages", "fixture-plugin"),
      join(repositoryRoot, "node_modules", "fixture-plugin"),
      "dir",
    );

    const workspace = await createProjectWorkspace(
      { repositoryRoot, snapshotRoot, projectRoot: "." },
      new AbortController().signal,
    );
    onTestFinished(() => workspace.dispose());

    const linked = await lstat(
      join(workspace.treeRoot, "node_modules", "fixture-plugin"),
    );
    expect(linked.isSymbolicLink()).toBe(true);
    const resolved = await readFile(
      join(workspace.treeRoot, "node_modules", "fixture-plugin", "package.json"),
      "utf8",
    );
    expect(resolved).toContain("1.0.0");
  });

  it("rejects a dependency that resolves to live repository code without a snapshot copy", async () => {
    const snapshotRoot = await mkdtemp(join(tmpdir(), "zedbee-workspace-bad-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "zedbee-workspace-badrepo-"));
    onTestFinished(async () => {
      await rm(snapshotRoot, { recursive: true, force: true });
      await rm(repositoryRoot, { recursive: true, force: true });
    });
    await writeFile(
      join(snapshotRoot, "package.json"),
      `${JSON.stringify({
        name: "fixture",
        devDependencies: { "live-plugin": "*" },
      })}\n`,
    );
    await writeFile(join(repositoryRoot, "package.json"), "{}");
    // Symlink into a live directory that the snapshot does not contain.
    await mkdir(join(repositoryRoot, "live-plugin"), { recursive: true });
    await mkdir(join(repositoryRoot, "node_modules"), { recursive: true });
    await symlink(
      join(repositoryRoot, "live-plugin"),
      join(repositoryRoot, "node_modules", "live-plugin"),
      "dir",
    );

    await expect(
      createProjectWorkspace(
        { repositoryRoot, snapshotRoot, projectRoot: "." },
        new AbortController().signal,
      ),
    ).rejects.toThrow(ProjectWorkspaceLayoutError);
  });

  it("cleans only its own directory", async () => {
    const { root } = await snapshotFixture();
    const repositoryRoot = await mkdtemp(join(tmpdir(), "zedbee-workspace-repo2-"));
    onTestFinished(() => rm(repositoryRoot, { recursive: true, force: true }));
    await mkdir(join(repositoryRoot, "node_modules", "prettier"), {
      recursive: true,
    });
    await writeFile(
      join(repositoryRoot, "node_modules", "prettier", "package.json"),
      '{"name":"prettier","version":"3.9.6"}',
    );

    const workspace = await createProjectWorkspace(
      { repositoryRoot, snapshotRoot: root, projectRoot: "." },
      new AbortController().signal,
    );
    const workspaceRoot = workspace.root;
    const sentinel = await mkdtemp(join(tmpdir(), "zedbee-workspace-sentinel-"));
    onTestFinished(() => rm(sentinel, { recursive: true, force: true }));
    await writeFile(join(sentinel, "keep.txt"), "keep");

    await workspace.dispose();

    await expect(lstat(workspaceRoot)).rejects.toThrow();
    expect(await readFile(join(sentinel, "keep.txt"), "utf8")).toBe("keep");
  });
});
