import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
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

export interface ContainedLineReadOptions extends ContainedFileReadHooks {
  readonly maxCodePoints: number;
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

async function withValidatedContainedFile<T>(
  registry: SnapshotRegistry,
  repositoryPath: string,
  hooks: ContainedFileReadHooks,
  use: (handle: FileHandle, size: bigint) => Promise<T>,
): Promise<T> {
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
    return await use(handle, openedIdentity.size);
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
  return withValidatedContainedFile(
    registry,
    repositoryPath,
    options,
    async (handle, size) => {
      if (maxBytes !== undefined && size > BigInt(maxBytes)) {
        throw new ContainedFileSizeError(repositoryPath, maxBytes);
      }
      if (maxBytes === undefined) {
        return handle.readFile({ encoding: "utf8" });
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
    },
  );
}

export async function readContainedLines(
  registry: SnapshotRegistry,
  repositoryPath: string,
  lineNumbers: readonly number[],
  options: ContainedLineReadOptions,
): Promise<ReadonlyMap<number, string>> {
  if (
    !Number.isSafeInteger(options.maxCodePoints) ||
    options.maxCodePoints < 0
  ) {
    throw new TypeError("Expected a non-negative safe code-point limit");
  }
  if (lineNumbers.some((line) => !Number.isSafeInteger(line) || line < 1)) {
    throw new TypeError("Expected positive safe line numbers");
  }
  const requestedLines = [...new Set(lineNumbers)].sort(
    (left, right) => left - right,
  );
  if (requestedLines.length === 0) return new Map();
  const requested = new Set(requestedLines);
  const lastRequested = requestedLines.at(-1)!;

  return withValidatedContainedFile(
    registry,
    repositoryPath,
    options,
    async (handle) => {
      const result = new Map<number, string>();
      const decoder = new StringDecoder("utf8");
      let line = 1;
      let retained: string[] = [];
      let retainedCodePoints = 0;
      let skipLineFeed = false;
      let finished = false;

      const finishLine = (): void => {
        if (requested.has(line)) result.set(line, retained.join(""));
        if (line >= lastRequested) {
          finished = true;
          return;
        }
        line += 1;
        retained = [];
        retainedCodePoints = 0;
      };

      const consume = (text: string): void => {
        for (const codePoint of text) {
          if (skipLineFeed) {
            skipLineFeed = false;
            if (codePoint === "\n") continue;
          }
          if (codePoint === "\r") {
            finishLine();
            skipLineFeed = true;
          } else if (
            codePoint === "\n" ||
            codePoint === "\u2028" ||
            codePoint === "\u2029"
          ) {
            finishLine();
          } else if (
            requested.has(line) &&
            retainedCodePoints < options.maxCodePoints
          ) {
            retained.push(codePoint);
            retainedCodePoints += 1;
          }
          if (finished) return;
        }
      };

      while (!finished) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        consume(decoder.write(buffer.subarray(0, bytesRead)));
      }
      if (!finished) {
        consume(decoder.end());
        if (!finished && requested.has(line)) {
          result.set(line, retained.join(""));
        }
      }
      return result;
    },
  );
}

export async function digestContainedLineRange(
  registry: SnapshotRegistry,
  repositoryPath: string,
  startLine: number,
  endLine: number,
): Promise<string> {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new TypeError("Expected a valid positive line range");
  }
  return withValidatedContainedFile(
    registry,
    repositoryPath,
    {},
    async (handle) => {
      const hash = createHash("sha256");
      const decoder = new StringDecoder("utf8");
      let line = 1;
      let skipLineFeed = false;
      let finished = false;

      const consume = (text: string): void => {
        for (const codePoint of text) {
          if (skipLineFeed) {
            skipLineFeed = false;
            if (codePoint === "\n") continue;
          }
          if (
            codePoint === "\r" ||
            codePoint === "\n" ||
            codePoint === "\u2028" ||
            codePoint === "\u2029"
          ) {
            if (line >= startLine && line <= endLine) hash.update("\n", "utf8");
            if (codePoint === "\r") skipLineFeed = true;
            if (line >= endLine) {
              finished = true;
              return;
            }
            line += 1;
          } else if (line >= startLine && line <= endLine) {
            hash.update(codePoint, "utf8");
          }
        }
      };

      while (!finished) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        consume(decoder.write(buffer.subarray(0, bytesRead)));
      }
      if (!finished) consume(decoder.end());
      return hash.digest("hex");
    },
  );
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
