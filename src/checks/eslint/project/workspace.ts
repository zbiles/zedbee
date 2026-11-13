import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  createProjectWorkspace,
  type ProjectWorkspace,
} from "../../prettier/project-workspace.js";
import { isContainedPath } from "../../../inspection/read-json.js";
import { ProjectEslintFailureError, type ProjectEslintInput } from "./types.js";

// The reused formatter mirror omits larger files. ESLint rules may inspect any
// captured data file, so omission must instead make this check incomplete.
const MAX_MIRROR_FILE_BYTES = 32 * 1024 * 1024;

async function inventory(
  root: string,
  signal: AbortSignal,
  installedDependencies: boolean,
): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  const relativePath = (path: string): string =>
    relative(root, path).split(sep).join("/");
  const digest = async (path: string, size: number): Promise<string> => {
    if (size > MAX_MIRROR_FILE_BYTES) throw new Error("Oversized input");
    const bytes = await readFile(path, { signal });
    if (bytes.length !== size) throw new Error("Input changed during capture");
    return createHash("sha256").update(bytes).digest("hex");
  };
  const walk = async (directory: string): Promise<void> => {
    signal.throwIfAborted();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") {
        if (installedDependencies) continue;
        throw new Error("Captured dependencies cannot be omitted");
      }
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      const name = relativePath(path);
      if (metadata.isDirectory()) {
        files.set(name, "directory");
        await walk(path);
      } else if (metadata.isFile()) {
        files.set(
          name,
          `file:${metadata.size}:${await digest(path, metadata.size)}`,
        );
      } else if (metadata.isSymbolicLink()) {
        const target = await realpath(path);
        if (!isContainedPath(root, target)) throw new Error("External link");
        const targetMetadata = await lstat(target);
        if (!targetMetadata.isFile()) throw new Error("Unsupported link");
        files.set(
          name,
          `symlink:${relativePath(target)}:${await digest(target, targetMetadata.size)}`,
        );
      } else throw new Error("Unsupported captured input");
    }
  };
  await walk(root);
  return files;
}

export async function createProjectEslintWorkspace(
  input: ProjectEslintInput,
): Promise<{ workspace: ProjectWorkspace; configFile: string }> {
  let workspace: ProjectWorkspace | undefined;
  try {
    const captured = await inventory(
      await realpath(input.snapshotRoot),
      input.signal,
      false,
    );
    if (
      input.files.some((file) => {
        const value = captured.get(file);
        return value === undefined || value === "directory";
      })
    )
      throw new Error("Requested input is not captured");
    workspace = await createProjectWorkspace(
      {
        repositoryRoot: input.checkoutRoot,
        snapshotRoot: input.snapshotRoot,
        projectRoot: input.projectRoot,
      },
      input.signal,
    );
    const mirrored = await inventory(workspace.treeRoot, input.signal, true);
    if (
      captured.size !== mirrored.size ||
      [...captured].some(([path, identity]) => mirrored.get(path) !== identity)
    )
      throw new Error("The mirror does not preserve captured inputs");
  } catch {
    await workspace?.dispose().catch(() => undefined);
    throw new ProjectEslintFailureError(
      input.signal.aborted
        ? "PROJECT_ESLINT_CANCELLED"
        : "PROJECT_ESLINT_LAYOUT_UNSUPPORTED",
    );
  }
  let directory = resolve(workspace.treeRoot, input.projectRoot);
  while (isContainedPath(workspace.treeRoot, directory)) {
    for (const name of [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
    ]) {
      const file = join(directory, name);
      if (
        await lstat(file)
          .then((value) => value.isFile() || value.isSymbolicLink())
          .catch(() => false)
      )
        return { workspace, configFile: file };
    }
    if (directory === workspace.treeRoot) break;
    directory = dirname(directory);
  }
  await workspace.dispose();
  throw new ProjectEslintFailureError("PROJECT_ESLINT_CONFIG_UNSUPPORTED");
}
