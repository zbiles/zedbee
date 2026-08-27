import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeWorkingFile } from "../../src/fixes/write-working-file.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) =>
      (await import("node:fs/promises")).rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-write-working-file-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "value.ts"), "old\n", { mode: 0o754 });
  return root;
}

describe("writeWorkingFile", () => {
  it.each(["../outside.ts", "/tmp/outside.ts", "C:\\outside.ts"])(
    "rejects an unsafe repository path %s",
    async (file) => {
      const root = await fixture();
      await expect(
        writeWorkingFile({ repositoryRoot: root, file, source: "new\n" }),
      ).rejects.toThrow("unsafe working-file path");
    },
  );

  it("rejects symlink files, symlink ancestors, and non-regular targets", async () => {
    const root = await fixture();
    await symlink("value.ts", join(root, "src", "linked.ts"));
    await symlink(join(root, "src"), join(root, "linked"));
    await mkdir(join(root, "src", "directory"));
    for (const file of ["src/linked.ts", "linked/value.ts", "src/directory"]) {
      await expect(
        writeWorkingFile({ repositoryRoot: root, file, source: "new\n" }),
      ).rejects.toThrow("unsafe working-file path");
    }
  });

  it("rejects a repository root reached through a symlink", async () => {
    const root = await fixture();
    const linkedRoot = `${root}-linked`;
    await symlink(root, linkedRoot, "dir");
    await expect(
      writeWorkingFile({
        repositoryRoot: linkedRoot,
        file: "src/value.ts",
        source: "new\n",
      }),
    ).rejects.toThrow("unsafe working-file path");
  });

  it("preserves modes and leaves no temporary files after an atomic replacement", async () => {
    const root = await fixture();
    await writeWorkingFile({
      repositoryRoot: root,
      file: "src/value.ts",
      source: "new\n",
    });
    expect(await readFile(join(root, "src", "value.ts"), "utf8")).toBe("new\n");
    expect((await lstat(join(root, "src", "value.ts"))).mode & 0o777).toBe(
      0o754,
    );
    expect(
      (
        await (await import("node:fs/promises")).readdir(join(root, "src"))
      ).filter((name) => name.startsWith(".zedbee-")),
    ).toEqual([]);
  });

  it("rejects a changed file identity and keeps complete old-or-new contents on injected write failure", async () => {
    const root = await fixture();
    const initial = await lstat(join(root, "src", "value.ts"), {
      bigint: true,
    });
    await writeWorkingFile({
      repositoryRoot: root,
      file: "src/value.ts",
      source: "new\n",
      expectedIdentity: { device: initial.dev, inode: initial.ino },
    });
    await expect(
      writeWorkingFile({
        repositoryRoot: root,
        file: "src/value.ts",
        source: "later\n",
        expectedIdentity: { device: initial.dev, inode: initial.ino },
      }),
    ).rejects.toThrow("changed");
    expect(await readFile(join(root, "src", "value.ts"), "utf8")).toBe("new\n");
    await expect(
      writeWorkingFile({
        repositoryRoot: root,
        file: "src/value.ts",
        source: "broken\n",
        dependencies: {
          write: async () => {
            throw new Error("injected");
          },
        },
      }),
    ).rejects.toThrow("injected");
    expect(["new\n", "broken\n"]).toContain(
      await readFile(join(root, "src", "value.ts"), "utf8"),
    );
  });

  it("revalidates target identity immediately before rename", async () => {
    const root = await fixture();
    const target = join(root, "src", "value.ts");
    const initial = await lstat(target, { bigint: true });
    await expect(
      writeWorkingFile({
        repositoryRoot: root,
        file: "src/value.ts",
        source: "new\n",
        expectedIdentity: { device: initial.dev, inode: initial.ino },
        dependencies: {
          write: async (handle, source) => {
            await handle.writeFile(source, "utf8");
            await writeFile(
              join(root, "src", "replacement.ts"),
              "replacement\n",
            );
            await (
              await import("node:fs/promises")
            ).rename(join(root, "src", "replacement.ts"), target);
          },
        },
      }),
    ).rejects.toThrow("changed");
    expect(await readFile(target, "utf8")).toBe("replacement\n");
  });

  it("revalidates unchanged target content immediately before rename", async () => {
    const root = await fixture();
    const target = join(root, "src", "value.ts");
    const initial = await lstat(target, { bigint: true });
    await expect(
      writeWorkingFile({
        repositoryRoot: root,
        file: "src/value.ts",
        source: "new\n",
        expectedIdentity: { device: initial.dev, inode: initial.ino },
        expectedSha256: createHash("sha256")
          .update("old\n", "utf8")
          .digest("hex"),
        dependencies: {
          write: async (handle, source) => {
            await handle.writeFile(source, "utf8");
            await writeFile(target, "concurrent\n");
          },
        },
      }),
    ).rejects.toThrow("changed");
    expect(await readFile(target, "utf8")).toBe("concurrent\n");
  });

  it("does not chmod, rename, or clean up a replaced temporary pathname", async () => {
    const root = await fixture();
    const directory = join(root, "src");
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside\n", { mode: 0o600 });
    await chmod(outside, 0o600);

    await expect(
      writeWorkingFile({
        repositoryRoot: root,
        file: "src/value.ts",
        source: "new\n",
        dependencies: {
          write: async (handle, source) => {
            await handle.writeFile(source, "utf8");
            const temporary = (await readdir(directory)).find((name) =>
              name.startsWith(".zedbee-"),
            );
            if (temporary === undefined) throw new Error("missing temp");
            await unlink(join(directory, temporary));
            await symlink(outside, join(directory, temporary));
          },
        },
      }),
    ).rejects.toThrow("unsafe");
    expect((await lstat(outside)).mode & 0o777).toBe(0o600);
    expect(await readFile(outside, "utf8")).toBe("outside\n");
    expect(
      (await readdir(directory)).some((name) => name.startsWith(".zedbee-")),
    ).toBe(true);
  });

  it("never cleans a temporary path through a swapped ancestor", async () => {
    const root = await fixture();
    const directory = join(root, "src");
    const movedDirectory = join(root, "src-original");
    const outside = await mkdtemp(join(tmpdir(), "zedbee-write-outside-"));
    roots.push(outside);

    await expect(
      writeWorkingFile({
        repositoryRoot: root,
        file: "src/value.ts",
        source: "new\n",
        dependencies: {
          write: async (handle, source) => {
            await handle.writeFile(source, "utf8");
            const temporary = (await readdir(directory)).find((name) =>
              name.startsWith(".zedbee-"),
            );
            if (temporary === undefined) throw new Error("missing temp");
            await rename(directory, movedDirectory);
            await symlink(outside, directory, "dir");
            await writeFile(join(outside, temporary), "outside\n");
          },
        },
      }),
    ).rejects.toThrow("unsafe");
    expect(
      await readFile(join(outside, (await readdir(outside))[0]!), "utf8"),
    ).toBe("outside\n");
    expect(
      (await readdir(movedDirectory)).some((name) =>
        name.startsWith(".zedbee-"),
      ),
    ).toBe(true);
  });

  it("rejects a duplicate in-flight target", async () => {
    const root = await fixture();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = writeWorkingFile({
      repositoryRoot: root,
      file: "src/value.ts",
      source: "first\n",
      dependencies: {
        write: async (handle, source) => {
          await handle.writeFile(source, "utf8");
          entered?.();
          await blocked;
        },
      },
    });
    await writing;
    await expect(
      writeWorkingFile({
        repositoryRoot: root,
        file: "src/value.ts",
        source: "second\n",
      }),
    ).rejects.toThrow("duplicate");
    release?.();
    await first;
  });

  it("invokes directory sync after a committed rename", async () => {
    const root = await fixture();
    const synced: string[] = [];
    await writeWorkingFile({
      repositoryRoot: root,
      file: "src/value.ts",
      source: "new\n",
      dependencies: {
        syncDirectory: async (directory) => {
          synced.push(directory);
        },
      },
    });
    expect(synced).toEqual([join(root, "src")]);
  });
});
