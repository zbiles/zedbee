import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { onTestFinished } from "vitest";

export interface InspectionFixture {
  readonly root: string;
  write(path: string, contents: string): Promise<void>;
  writeJson(path: string, value: unknown): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}

export async function createInspectionFixture(): Promise<InspectionFixture> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-inspection-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const write = async (path: string, contents: string): Promise<void> => {
    const fullPath = join(root, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  };

  return {
    root,
    write,
    writeJson(path, value) {
      return write(path, `${JSON.stringify(value, null, 2)}\n`);
    },
    async symlink(target, path) {
      const fullPath = join(root, path);
      await mkdir(dirname(fullPath), { recursive: true });
      const type =
        process.platform === "win32"
          ? (await lstat(resolve(dirname(fullPath), target))).isDirectory()
            ? "junction"
            : "file"
          : undefined;
      await symlink(target, fullPath, type);
    },
  };
}
