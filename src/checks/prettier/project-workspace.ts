import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import { canonicalizeSnapshotRoot } from "../../inspection/read-json.js";
import { discoverWorkspaces } from "../../inspection/workspaces.js";
import { compareCodeUnits } from "../../core/compare.js";
import { isContainedPath } from "../../inspection/read-json.js";

export interface ProjectWorkspaceInput {
  /** Canonical live checkout root; used only to locate installed dependency roots. */
  readonly repositoryRoot: string;
  readonly snapshotRoot: string;
  readonly projectRoot: string;
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

/** Layouts the mirror cannot reproduce faithfully fail instead of guessing. */
export class ProjectWorkspaceLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectWorkspaceLayoutError";
  }
}

const MAX_MIRROR_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DEPENDENCY_LINKS = 1024;

function repositoryRelative(
  root: string,
  absolute: string,
): string | undefined {
  const value = relative(root, absolute).split(sep).join("/");
  if (
    value === "" ||
    isAbsolute(value) ||
    value === ".." ||
    value.startsWith("../")
  ) {
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
      const path = repositoryRelative(snapshotRoot, absolute);
      if (path === undefined) continue;
      const destination = join(treeRoot, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(absolute), { mode: 0o600 });
    }
  };
  await walk(snapshotRoot);
}

/**
 * Plans the installed dependency links for the mirror. Only dependency roots
 * that the selected snapshot's own manifests declare are linked — never a
 * whole live `node_modules` tree. A link that resolves into a tracked
 * workspace package is remapped to that package's snapshot copy; anything
 * else that would reintroduce live repository code fails as an unsupported
 * layout.
 */
async function planDependencyLinks(
  input: ProjectWorkspaceInput,
  treeRoot: string,
): Promise<readonly { readonly linkPath: string; readonly target: string }[]> {
  const repositoryRoot = await canonicalizeSnapshotRoot(input.repositoryRoot);
  const registry = await captureSnapshotRegistry(
    await canonicalizeSnapshotRoot(input.snapshotRoot),
  );
  const workspaces = await discoverWorkspaces(registry);
  const links = new Map<string, string>();
  const workspaceRealRoots = await Promise.all(
    workspaces.map(async (workspace) => ({
      relativeRoot: workspace.relativeRoot,
      realRoot: await realpath(
        resolve(repositoryRoot, workspace.relativeRoot),
      ).catch(() => undefined),
    })),
  );

  for (const workspace of workspaces) {
    const names = new Set(
      workspace.manifest.dependencyDeclarations.map(({ name }) => name),
    );
    for (const name of names) {
      let directory: string | undefined = resolve(
        repositoryRoot,
        workspace.relativeRoot,
      );
      while (directory !== undefined && isContainedPath(repositoryRoot, directory)) {
        const candidate = join(directory, "node_modules", name);
        try {
          const metadata = await lstat(candidate);
          if (!metadata.isDirectory() && !metadata.isSymbolicLink()) {
            throw new Error("skip");
          }
          const real = await realpath(candidate);
          const linkPath = repositoryRelative(repositoryRoot, candidate);
          if (linkPath === undefined) throw new Error("skip");
          const fromRepositoryRoot = repositoryRelative(
            repositoryRoot,
            real,
          );
          const insideRepository =
            fromRepositoryRoot !== undefined;
          const underNodeModules =
            insideRepository &&
            fromRepositoryRoot!.split("/").includes("node_modules");
          if (metadata.isSymbolicLink() && insideRepository && !underNodeModules) {
            // A workspace package linked into node_modules must use the
            // snapshot copy, never live source or untracked build output.
            const owner = workspaceRealRoots.find(
              (entry) => entry.realRoot === real,
            );
            if (owner === undefined) {
              throw new ProjectWorkspaceLayoutError(
                `The ${name} installation resolves to live repository code outside the selected snapshot; this layout is unsupported.`,
              );
            }
            links.set(linkPath, join(treeRoot, ...owner.relativeRoot.split("/")));
          } else {
            links.set(linkPath, real);
          }
          break;
        } catch (error) {
          if (error instanceof ProjectWorkspaceLayoutError) throw error;
          /* Try the next hoisted level. */
        }
        if (directory === repositoryRoot) break;
        const parent = dirname(directory);
        directory = parent === directory ? undefined : parent;
      }
    }
  }

  if (links.size > MAX_DEPENDENCY_LINKS) {
    throw new ProjectWorkspaceLayoutError(
      "The project declares more dependencies than the formatting workspace supports.",
    );
  }
  return [...links.entries()]
    .map(([linkPath, target]) => ({ linkPath, target }))
    .sort((left, right) => compareCodeUnits(left.linkPath, right.linkPath));
}

async function attachDependencyLinks(
  treeRoot: string,
  links: readonly { readonly linkPath: string; readonly target: string }[],
): Promise<void> {
  for (const { linkPath, target } of links) {
    const destination = join(treeRoot, ...linkPath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await symlink(
      target,
      destination,
      process.platform === "win32" ? "junction" : "dir",
    ).catch(() => undefined);
  }
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
    await attachDependencyLinks(
      treeRoot,
      await planDependencyLinks(input, treeRoot),
    );
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
