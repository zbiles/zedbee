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

export interface ContainedFileReadOptions extends ContainedFileReadHooks {
  readonly maxBytes?: number;
}

export class ContainedFileSizeError extends Error {
  readonly code = "FILE_SIZE_LIMIT_EXCEEDED";
  readonly path: string;
  readonly maxBytes: number;

  constructor(repositoryPath: string, maxBytes: number) {
    super("Zedbee refused to read a file that exceeds its size limit.");
    this.name = "ContainedFileSizeError";
    this.path = normalizeRepositoryPath(repositoryPath);
    this.maxBytes = maxBytes;
    Object.freeze(this);
  }
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
  options: ContainedFileReadOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes;
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
  ) {
    throw new TypeError("Expected a non-negative safe file-size limit");
  }
  const registeredTarget = registry.resolve(repositoryPath);
  if (registeredTarget?.targetKind !== "file") {
    throw unreadablePath(repositoryPath);
  }
  const canonicalPath = registeredTarget.canonicalPath;
  await options.afterCanonicalize?.({ canonicalPath });

  await options.beforeOpen?.({ canonicalPath });

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
    await options.afterOpen?.({ canonicalPath });
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
    if (maxBytes !== undefined && openedIdentity.size > BigInt(maxBytes)) {
      throw new ContainedFileSizeError(repositoryPath, maxBytes);
    }
    if (maxBytes === undefined) {
      return await handle.readFile({ encoding: "utf8" });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes - total;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new ContainedFileSizeError(repositoryPath, maxBytes);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    if (
      error instanceof RepositoryInspectionError ||
      error instanceof ContainedFileSizeError
    ) {
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
