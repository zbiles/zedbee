import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { identitiesMatch, type SnapshotRegistry } from "./snapshot-registry.js";
import { RepositoryInspectionError } from "./types.js";

export function normalizeRepositoryPath(path: string): string {
  return path.split(sep).join("/");
}

export function isContainedPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

export async function canonicalizeSnapshotRoot(
  snapshotRoot: string,
): Promise<string> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(snapshotRoot));
    if (!(await lstat(canonicalRoot)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new RepositoryInspectionError(
      "UNSAFE_SNAPSHOT_PATH",
      "Zedbee could not access the repository snapshot.",
    );
  }
  return canonicalRoot;
}

function resolveLexicalPath(
  snapshotRoot: string,
  repositoryPath: string,
): string {
  const candidate = resolve(snapshotRoot, repositoryPath);
  if (isAbsolute(repositoryPath) || !isContainedPath(snapshotRoot, candidate)) {
    throw new RepositoryInspectionError(
      "UNSAFE_SNAPSHOT_PATH",
      "Zedbee refused a path outside the snapshot.",
    );
  }
  return candidate;
}

export async function resolveContainedRealPath(
  snapshotRoot: string,
  repositoryPath: string,
): Promise<string> {
  const candidate = resolveLexicalPath(snapshotRoot, repositoryPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidate);
  } catch {
    throw new RepositoryInspectionError(
      "INVALID_SNAPSHOT_DATA",
      `Zedbee could not read ${normalizeRepositoryPath(repositoryPath)} from the snapshot.`,
    );
  }
  if (!isContainedPath(snapshotRoot, canonicalPath)) {
    throw new RepositoryInspectionError(
      "UNSAFE_SNAPSHOT_PATH",
      "Zedbee refused a path outside the snapshot.",
    );
  }
  return canonicalPath;
}

export interface ContainedFileReadHooks {
  afterCanonicalize?(context: {
    readonly canonicalPath: string;
  }): Promise<void> | void;
  beforeOpen?(context: {
    readonly canonicalPath: string;
  }): Promise<void> | void;
  afterOpen?(context: { readonly canonicalPath: string }): Promise<void> | void;
}

const NO_FOLLOW_UNSUPPORTED_CODES = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

function unsafePath(): RepositoryInspectionError {
  return new RepositoryInspectionError(
    "UNSAFE_SNAPSHOT_PATH",
    "Zedbee refused a path outside the snapshot.",
  );
}

function unreadablePath(repositoryPath: string): RepositoryInspectionError {
  return new RepositoryInspectionError(
    "INVALID_SNAPSHOT_DATA",
    `Zedbee could not read ${normalizeRepositoryPath(repositoryPath)} from the snapshot.`,
  );
}

async function openWithoutFollowing(
  canonicalPath: string,
): Promise<FileHandle> {
  const noFollow = constants.O_NOFOLLOW;
  if (
    typeof noFollow !== "number" ||
    noFollow === 0 ||
    process.platform === "win32"
  ) {
    return open(canonicalPath, constants.O_RDONLY);
  }

  try {
    return await open(canonicalPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (
      NO_FOLLOW_UNSUPPORTED_CODES.has(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return open(canonicalPath, constants.O_RDONLY);
    }
    throw error;
  }
}

export async function readContainedFile(
  registry: SnapshotRegistry,
  repositoryPath: string,
  hooks: ContainedFileReadHooks = {},
): Promise<string> {
  const registeredTarget = registry.resolve(repositoryPath);
  if (registeredTarget?.targetKind !== "file") {
    throw unreadablePath(repositoryPath);
  }
  const canonicalPath = registeredTarget.canonicalPath;
  await hooks.afterCanonicalize?.({ canonicalPath });

  await hooks.beforeOpen?.({ canonicalPath });

  let handle: FileHandle;
  try {
    handle = await openWithoutFollowing(canonicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw unsafePath();
    }
    throw unreadablePath(repositoryPath);
  }

  try {
    await hooks.afterOpen?.({ canonicalPath });
    const openedIdentity = await handle.stat({ bigint: true });
    if (
      !openedIdentity.isFile() ||
      !identitiesMatch(openedIdentity, registeredTarget.targetIdentity)
    ) {
      throw unsafePath();
    }

    const components = normalizeRepositoryPath(repositoryPath).split("/");
    const ancestors = [
      ".",
      ...components.map((_, index) => components.slice(0, index + 1).join("/")),
    ];
    for (const ancestor of ancestors) {
      const registeredAncestor = registry.resolve(ancestor);
      if (registeredAncestor === undefined) throw unsafePath();
      const currentIdentity = await lstat(
        ancestor === "."
          ? registry.snapshotRoot
          : resolve(registry.snapshotRoot, ancestor),
        { bigint: true },
      );
      if (
        !identitiesMatch(currentIdentity, registeredAncestor.lexicalIdentity)
      ) {
        throw unsafePath();
      }
    }
    const currentCanonicalPath = await realpath(
      resolve(registry.snapshotRoot, repositoryPath),
    );
    if (currentCanonicalPath !== registeredTarget.canonicalPath) {
      throw unsafePath();
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error instanceof RepositoryInspectionError) {
      throw error;
    }
    throw unreadablePath(repositoryPath);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readJsonData(
  registry: SnapshotRegistry,
  repositoryPath: string,
  hooks: ContainedFileReadHooks = {},
): Promise<unknown> {
  const contents = await readContainedFile(registry, repositoryPath, hooks);

  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new RepositoryInspectionError(
      "INVALID_SNAPSHOT_DATA",
      `Zedbee could not parse ${normalizeRepositoryPath(repositoryPath)} as JSON.`,
    );
  }
}
