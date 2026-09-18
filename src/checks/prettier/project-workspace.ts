import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { compareCodeUnits } from "../../core/compare.js";
import { isContainedPath } from "../../inspection/read-json.js";

export interface DependencyRoot {
  /** Repository-relative directory that should carry an installed link, e.g. "node_modules" or "apps/web/node_modules". */
  readonly relativePath: string;
  /** Validated absolute realpath of the installed directory. */
  readonly absolutePath: string;
}

export interface ProjectWorkspaceInput {
  readonly snapshotRoot: string;
  readonly projectRoot: string;
  readonly dependencyRoots: readonly DependencyRoot[];
}

export interface ProjectWorkspace {
  /** Owned temporary directory. */
  readonly root: string;
  /** Mirrored snapshot tree. */
  readonly treeRoot: string;
  /** Working directory for the formatter worker. */
  readonly workerCwd: string;
  dispose(): Promise<void>;
}

const MAX_MIRROR_FILE_BYTES = 32 * 1024 * 1024;

function relativeRepositoryPath(
  snapshotRoot: string,
  absolute: string,
): string | undefined {
  const value = relative(snapshotRoot, absolute).split(sep).join("/");
  if (value === "" || isAbsolute(value) || value === ".." || value.startsWith("../")) {
    return undefined;
  }
  return value;
}

async function copyRegularFiles(
  snapshotRoot: string,
  treeRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    if (signal.aborted) throw new Error("Workspace build aborted");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    )) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(absolute);
        continue;
      }
      if (!metadata.isFile()) continue;
      if (metadata.size > MAX_MIRROR_FILE_BYTES) continue;
      const repositoryPath = relativeRepositoryPath(snapshotRoot, absolute);
      if (repositoryPath === undefined) continue;
      const destination = join(treeRoot, ...repositoryPath.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(absolute), { mode: 0o600 });
    }
  };
  await walk(snapshotRoot);
}

async function attachDependencyRoot(
  treeRoot: string,
  dependency: DependencyRoot,
): Promise<void> {
  const destination = join(treeRoot, ...dependency.relativePath.split("/"));
  if (!isContainedPath(treeRoot, destination)) return;
  try {
    const metadata = await lstat(dependency.absolutePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  } catch {
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await symlink(
    dependency.absolutePath,
    destination,
    process.platform === "win32" ? "junction" : "dir",
  ).catch(() => undefined);
}

export async function createProjectWorkspace(
  input: ProjectWorkspaceInput,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProjectWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-project-workspace-"));
  const treeRoot = join(root, "tree");
  let disposed = false;
  try {
    await mkdir(treeRoot, { recursive: true });
    // Bound EditorConfig lookup above the mirror without touching the repository.
    await writeFile(join(root, ".editorconfig"), "root = true\n", {
      mode: 0o600,
    });
    await copyRegularFiles(input.snapshotRoot, treeRoot, signal);
    for (const dependency of input.dependencyRoots) {
      await attachDependencyRoot(treeRoot, dependency);
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const workerCwd = join(treeRoot, ...input.projectRoot.split("/"));
  await mkdir(workerCwd, { recursive: true });
  return Object.freeze({
    root,
    treeRoot,
    workerCwd,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  });
}

/** Exposes the open flag constants for callers that need bounded reads. */
export const PROJECT_WORKSPACE_READ_FLAGS = constants.O_RDONLY;

export function resolveInsideTree(
  treeRoot: string,
  candidate: string,
): string | undefined {
  const absolute = resolve(treeRoot, candidate);
  return isContainedPath(treeRoot, absolute) ? absolute : undefined;
}
