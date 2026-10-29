import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SnapshotError } from "./snapshot-path.js";

async function verify(path: string) {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(path)) !== path
  ) {
    throw new SnapshotError(
      "INVALID_TEMP_PATH",
      "Zedbee refused an unsafe temporary snapshot directory.",
    );
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

export function createSnapshotDirectories(root: string): {
  ensure(repositoryPath: string): Promise<void>;
} {
  const parents = new Map<string, Promise<{ dev: bigint; ino: bigint }>>();
  async function checked(path: string, create: boolean) {
    let initial = parents.get(path);
    if (initial === undefined) {
      initial = (async () => {
        if (create) {
          try {
            await mkdir(path, { mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        return verify(path);
      })();
      parents.set(path, initial);
    }
    const identity = await initial;
    const current = await verify(path);
    if (identity.dev !== current.dev || identity.ino !== current.ino) {
      throw new SnapshotError(
        "INVALID_TEMP_PATH",
        "Zedbee refused a temporary snapshot directory whose identity changed.",
      );
    }
  }
  return {
    async ensure(repositoryPath) {
      const parts = repositoryPath.split("/");
      if (
        repositoryPath.includes("\\") ||
        repositoryPath.includes("\0") ||
        parts.some((part) => part === "" || part === "." || part === "..")
      ) {
        throw new SnapshotError(
          "INVALID_INDEX_PATH",
          "Zedbee refused an invalid selected repository path.",
        );
      }
      await checked(root, false);
      let current = root;
      for (const part of parts.slice(0, -1)) {
        current = join(current, part);
        await checked(current, true);
      }
    },
  };
}
