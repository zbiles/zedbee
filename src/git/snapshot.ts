import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { compareCodeUnits } from "../core/compare.js";
import type { GitBlobStream } from "./batch-object-stream.js";
import type { GitClient } from "./client.js";
import { GitCommandError } from "./errors.js";
import {
  SNAPSHOT_PREFIX,
  SnapshotError,
  type ValidatedSnapshotPath,
  validateSnapshotPath,
} from "./snapshot-path.js";

export { SnapshotError, type SnapshotErrorCode } from "./snapshot-path.js";

export type UnsupportedIndexEntryKind =
  "binary" | "git-lfs-pointer" | "submodule";

export interface UnsupportedIndexEntry {
  path: string;
  kind: UnsupportedIndexEntryKind;
}

export interface SnapshotPair {
  baselineDir: string;
  targetDir: string;
  baselineRef: string | null;
  targetRef: "index" | string;
  baselineUnsupportedEntries?: readonly UnsupportedIndexEntry[];
  baselineSymlinkPaths?: readonly string[];
  symlinkPaths?: readonly string[];
  unsupportedEntries: readonly UnsupportedIndexEntry[];
  cleanup(): Promise<void>;
}

export async function countSnapshotFileLines(
  snapshotRoot: string,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  await verifyDirectory(snapshotRoot);
  const source = containedPath(snapshotRoot, repositoryPath);
  if (source === undefined) return invalidSelectedPath();
  const pathMetadata = await lstat(source);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) return undefined;
  let handle: FileHandle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return undefined;
    throw error;
  }
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  let lines = 0;
  let lastByte = -1;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return undefined;
    while (true) {
      if (signal?.aborted === true) {
        throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
      }
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      lastByte = buffer[bytesRead - 1]!;
      const chunk = buffer.subarray(0, bytesRead);
      let newline = chunk.indexOf(0x0a);
      while (newline !== -1) {
        lines += 1;
        newline = chunk.indexOf(0x0a, newline + 1);
      }
      if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(lines)) {
        throw new Error("Snapshot file is too large to count safely.");
      }
    }
  } finally {
    await handle.close();
  }
  return bytes === 0 ? 0 : lines + (lastByte === 0x0a ? 0 : 1);
}

export class SnapshotConstructionCleanupError extends Error {
  readonly constructionError: SnapshotError;
  readonly temporaryPath?: ValidatedSnapshotPath;

  constructor(
    constructionError: SnapshotError,
    temporaryPath?: ValidatedSnapshotPath,
  ) {
    super("Zedbee snapshot construction and cleanup both failed.");
    this.name = "SnapshotConstructionCleanupError";
    this.constructionError = constructionError;
    if (temporaryPath !== undefined) this.temporaryPath = temporaryPath;
  }
}

function safeConstructionError(error: unknown): SnapshotError {
  if (error instanceof SnapshotError && error.code === "INVALID_INDEX_PATH") {
    return new SnapshotError(
      error.code,
      "Zedbee refused an invalid selected repository path.",
    );
  }
  if (error instanceof SnapshotError && error.code === "INVALID_TEMP_PATH") {
    return new SnapshotError(
      error.code,
      "Zedbee refused an unsafe temporary snapshot path.",
    );
  }
  if (error instanceof SnapshotError && error.code === "UNRESOLVED_INDEX") {
    return new SnapshotError(
      error.code,
      "Zedbee cannot build snapshots for an unresolved index.",
    );
  }
  return new SnapshotError(
    "SNAPSHOT_CONSTRUCTION_FAILED",
    "Zedbee could not construct the selected snapshots.",
  );
}

type SnapshotEntryMode = "100644" | "100755" | "120000" | "160000";

interface SnapshotEntry {
  mode: SnapshotEntryMode;
  objectId: string;
  path: string;
}

const MAX_SYMLINK_TARGET_BYTES = 1024 * 1024;

const OBJECT_ID = "(?:[\\da-f]{40}|[\\da-f]{64})";
const STAGED_ENTRY = new RegExp(
  `^([0-7]{6}) (${OBJECT_ID}) ([0-3])\\t([\\s\\S]+)$`,
  "u",
);
const TREE_ENTRY = new RegExp(
  `^([0-7]{6}) (blob|commit) (${OBJECT_ID})\\t([\\s\\S]+)$`,
  "u",
);

function supportedMode(mode: string): mode is SnapshotEntryMode {
  return (
    mode === "100644" ||
    mode === "100755" ||
    mode === "120000" ||
    mode === "160000"
  );
}

function invalidSelectedPath(): never {
  throw new SnapshotError(
    "INVALID_INDEX_PATH",
    "Zedbee refused an invalid selected repository path.",
  );
}

function parseStagedEntries(output: string): SnapshotEntry[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) return invalidSelectedPath();

  return output
    .slice(0, -1)
    .split("\0")
    .map((record) => {
      const match = STAGED_ENTRY.exec(record);
      if (match === null || !supportedMode(match[1]!)) {
        return invalidSelectedPath();
      }
      if (match[3] !== "0") {
        throw new SnapshotError(
          "UNRESOLVED_INDEX",
          "Zedbee cannot build a staged snapshot while the index has unresolved entries.",
        );
      }
      return { mode: match[1], objectId: match[2]!, path: match[4]! };
    });
}

function parseTreeEntries(output: string): SnapshotEntry[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) return invalidSelectedPath();

  return output
    .slice(0, -1)
    .split("\0")
    .map((record) => {
      const match = TREE_ENTRY.exec(record);
      if (match === null || !supportedMode(match[1]!)) {
        return invalidSelectedPath();
      }
      const expectedType = match[1] === "160000" ? "commit" : "blob";
      if (match[2] !== expectedType) return invalidSelectedPath();
      return { mode: match[1], objectId: match[3]!, path: match[4]! };
    });
}

const INTENT_TO_ADD_FLAG = 0x20000000;
const INDEX_DEBUG_METADATA =
  /^  ctime: \d+:\d+\n  mtime: \d+:\d+\n  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n  size: \d+\tflags: ([\da-f]+)(?:\n|$)/;

function parseIntentToAddPaths(output: string): Set<string> {
  const paths = new Set<string>();
  let remaining = output;
  while (remaining !== "") {
    const pathEnd = remaining.indexOf("\0");
    if (pathEnd === -1) throw new Error("Git returned invalid index metadata.");
    const path = remaining.slice(0, pathEnd);
    const metadata = remaining.slice(pathEnd + 1);
    const match = INDEX_DEBUG_METADATA.exec(metadata);
    if (match === null) throw new Error("Git returned invalid index metadata.");
    if ((Number.parseInt(match[1]!, 16) & INTENT_TO_ADD_FLAG) !== 0) {
      paths.add(path);
    }
    remaining = metadata.slice(match[0].length);
  }
  return paths;
}

function containedPath(
  root: string,
  repositoryPath: string,
): string | undefined {
  if (
    repositoryPath === "" ||
    repositoryPath.includes("\uFFFD") ||
    isAbsolute(repositoryPath)
  ) {
    return undefined;
  }
  const parts = repositoryPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return undefined;
  }
  const candidate = resolve(root, repositoryPath);
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === "" ||
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  return candidate;
}

function validateEntryPaths(
  repositoryRoot: string,
  entries: readonly SnapshotEntry[],
): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (
      containedPath(repositoryRoot, entry.path) === undefined ||
      paths.has(entry.path)
    ) {
      return invalidSelectedPath();
    }
    paths.add(entry.path);
  }
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== ".") {
      if (paths.has(parent)) return invalidSelectedPath();
      parent = dirname(parent);
    }
  }
}

async function createCanonicalSnapshotParent(): Promise<ValidatedSnapshotPath> {
  const temporaryParent = await mkdtemp(join(tmpdir(), SNAPSHOT_PREFIX));
  try {
    return await validateSnapshotPath(await realpath(temporaryParent));
  } catch (error) {
    await rm(temporaryParent, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

async function verifyDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SnapshotError(
      "INVALID_TEMP_PATH",
      "Zedbee refused an unsafe temporary snapshot directory.",
    );
  }
  if ((await realpath(path)) !== path) {
    throw new SnapshotError(
      "INVALID_TEMP_PATH",
      "Zedbee refused a temporary snapshot directory whose identity changed.",
    );
  }
}

async function createParentDirectories(
  destinationRoot: string,
  repositoryPath: string,
): Promise<string> {
  await verifyDirectory(destinationRoot);
  let current = destinationRoot;
  for (const part of repositoryPath.split("/").slice(0, -1)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await verifyDirectory(current);
  }
  return current;
}

async function writeRegularBlob(
  destinationRoot: string,
  entry: SnapshotEntry,
  blob: GitBlobStream,
  signal?: AbortSignal,
): Promise<{ prefix: Buffer; containsNul: boolean }> {
  await createParentDirectories(destinationRoot, entry.path);
  const destination = containedPath(destinationRoot, entry.path);
  if (destination === undefined) return invalidSelectedPath();
  const handle = await open(
    destination,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    entry.mode === "100755" ? 0o755 : 0o644,
  );
  const prefixChunks: Buffer[] = [];
  let prefixLength = 0;
  let written = 0;
  let containsNul = false;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Snapshot target is not a file.");
    for await (const chunk of blob.chunks) {
      if (signal?.aborted === true) {
        throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
      }
      written += chunk.length;
      if (written > blob.size) {
        throw new Error("Git returned an invalid batch object response.");
      }
      if (!containsNul && chunk.includes(0)) containsNul = true;
      if (prefixLength < 8192) {
        const prefix = chunk.subarray(0, 8192 - prefixLength);
        prefixChunks.push(Buffer.from(prefix));
        prefixLength += prefix.length;
      }
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset);
        if (result.bytesWritten <= 0) {
          throw new Error("Zedbee could not write a snapshot blob.");
        }
        offset += result.bytesWritten;
      }
    }
    if (written !== blob.size) {
      throw new Error("Git returned an invalid batch object response.");
    }
    await handle.chmod(entry.mode === "100755" ? 0o755 : 0o644);
  } finally {
    await handle.close();
  }
  const metadata = await lstat(destination);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (await realpath(destination)) !== destination
  ) {
    throw new SnapshotError(
      "INVALID_TEMP_PATH",
      "Zedbee refused a temporary snapshot file whose identity changed.",
    );
  }
  return { prefix: Buffer.concat(prefixChunks, prefixLength), containsNul };
}

async function writeSymlinkBlob(
  destinationRoot: string,
  entry: SnapshotEntry,
  blob: GitBlobStream,
  signal?: AbortSignal,
): Promise<void> {
  if (blob.size > MAX_SYMLINK_TARGET_BYTES) return invalidSelectedPath();
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of blob.chunks) {
    if (signal?.aborted === true) {
      throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
    }
    length += chunk.length;
    if (length > blob.size) {
      throw new Error("Git returned an invalid batch object response.");
    }
    chunks.push(Buffer.from(chunk));
  }
  if (length !== blob.size) {
    throw new Error("Git returned an invalid batch object response.");
  }
  const bytes = Buffer.concat(chunks, length);
  await createParentDirectories(destinationRoot, entry.path);
  const destination = containedPath(destinationRoot, entry.path);
  if (destination === undefined || bytes.includes(0))
    return invalidSelectedPath();
  const target = bytes.toString("utf8");
  if (!Buffer.from(target, "utf8").equals(bytes)) return invalidSelectedPath();
  await symlink(target, destination);
  if (!(await lstat(destination)).isSymbolicLink()) {
    throw new SnapshotError(
      "INVALID_TEMP_PATH",
      "Zedbee refused an invalid materialized symbolic link.",
    );
  }
}

function classifyBlob(
  entry: SnapshotEntry,
  bytes: Buffer,
  containsNul: boolean,
): UnsupportedIndexEntry | undefined {
  if (containsNul) {
    return { path: entry.path, kind: "binary" };
  }
  if (
    bytes
      .subarray(0, 8192)
      .toString("utf8")
      .startsWith("version https://git-lfs.github.com/spec/v1\n")
  ) {
    return { path: entry.path, kind: "git-lfs-pointer" };
  }
  return undefined;
}

async function materializeEntries(
  git: GitClient,
  entries: readonly SnapshotEntry[],
  destinationRoot: string,
  classify: boolean,
  signal?: AbortSignal,
): Promise<UnsupportedIndexEntry[]> {
  const unsupported: UnsupportedIndexEntry[] = entries.flatMap((entry) =>
    classify && entry.mode === "160000"
      ? [{ path: entry.path, kind: "submodule" as const }]
      : [],
  );
  const options = signal === undefined ? {} : { signal };
  const blobs = entries.filter((entry) => entry.mode !== "160000");
  let entryIndex = 0;
  await git.streamBlobs(
    blobs.map((entry) => entry.objectId),
    async (blob) => {
      const entry = blobs[entryIndex];
      entryIndex += 1;
      if (entry === undefined || blob.objectId !== entry.objectId) {
        throw new Error("Git returned an invalid batch object response.");
      }
      if (entry.mode === "120000") {
        await writeSymlinkBlob(destinationRoot, entry, blob, signal);
        return;
      }
      const { prefix, containsNul } = await writeRegularBlob(
        destinationRoot,
        entry,
        blob,
        signal,
      );
      const unsupportedEntry = classify
        ? classifyBlob(entry, prefix, containsNul)
        : undefined;
      if (unsupportedEntry !== undefined) unsupported.push(unsupportedEntry);
    },
    options,
  );
  if (entryIndex !== blobs.length) {
    throw new Error("Git returned an invalid batch object response.");
  }
  return unsupported.sort(
    (left, right) =>
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.kind, right.kind),
  );
}

async function readCommitEntries(
  repositoryRoot: string,
  git: GitClient,
  commit: string,
  signal?: AbortSignal,
): Promise<SnapshotEntry[]> {
  const output = await git.run(
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    signal === undefined ? {} : { signal },
  );
  const entries = parseTreeEntries(output.stdout);
  validateEntryPaths(repositoryRoot, entries);
  return entries;
}

interface OwnedSnapshotRoot {
  canonicalParent: ValidatedSnapshotPath;
  baselineDir: string;
  targetDir: string;
  cleanup(): Promise<void>;
}

async function createOwnedSnapshotRoot(): Promise<OwnedSnapshotRoot> {
  const canonicalParent = await createCanonicalSnapshotParent();
  const baselineDir = join(canonicalParent, "baseline");
  const targetDir = join(canonicalParent, "target");
  let cleaned = false;
  const root: OwnedSnapshotRoot = {
    canonicalParent,
    baselineDir,
    targetDir,
    async cleanup() {
      if (cleaned) return;
      try {
        await lstat(canonicalParent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          cleaned = true;
          return;
        }
        throw error;
      }
      const validatedParent = await validateSnapshotPath(canonicalParent);
      if (validatedParent !== canonicalParent) {
        throw new SnapshotError(
          "INVALID_TEMP_PATH",
          "Zedbee refused to clean a temporary path whose identity changed.",
        );
      }
      await rm(canonicalParent, { recursive: true, force: false });
      cleaned = true;
    },
  };
  try {
    await mkdir(baselineDir, { mode: 0o700 });
    await mkdir(targetDir, { mode: 0o700 });
    await verifyDirectory(baselineDir);
    await verifyDirectory(targetDir);
    return root;
  } catch (error) {
    return cleanupConstructionFailure(root, error);
  }
}

async function cleanupConstructionFailure(
  root: OwnedSnapshotRoot,
  error: unknown,
): Promise<never> {
  try {
    await root.cleanup();
  } catch {
    let temporaryPath: ValidatedSnapshotPath | undefined;
    try {
      temporaryPath = await validateSnapshotPath(root.canonicalParent);
    } catch {
      // Changed or inaccessible identities are intentionally unreportable.
    }
    throw new SnapshotConstructionCleanupError(
      safeConstructionError(error),
      temporaryPath,
    );
  }
  throw error;
}

export async function buildCommitSnapshotPair(
  repositoryRoot: string,
  git: GitClient,
  baselineCommit: string,
  targetCommit: string,
  signal?: AbortSignal,
): Promise<SnapshotPair> {
  const root = await createOwnedSnapshotRoot();
  try {
    const baselineEntries = await readCommitEntries(
      repositoryRoot,
      git,
      baselineCommit,
      signal,
    );
    const targetEntries = await readCommitEntries(
      repositoryRoot,
      git,
      targetCommit,
      signal,
    );
    const baselineSymlinkPaths = baselineEntries
      .filter((entry) => entry.mode === "120000")
      .map((entry) => entry.path);
    const symlinkPaths = targetEntries
      .filter((entry) => entry.mode === "120000")
      .map((entry) => entry.path);
    const baselineUnsupportedEntries = await materializeEntries(
      git,
      baselineEntries,
      root.baselineDir,
      true,
      signal,
    );
    const unsupportedEntries = await materializeEntries(
      git,
      targetEntries,
      root.targetDir,
      true,
      signal,
    );
    return {
      baselineDir: root.baselineDir,
      targetDir: root.targetDir,
      baselineRef: baselineCommit,
      targetRef: targetCommit,
      baselineUnsupportedEntries,
      baselineSymlinkPaths,
      symlinkPaths,
      unsupportedEntries,
      cleanup: root.cleanup,
    };
  } catch (error) {
    return cleanupConstructionFailure(root, error);
  }
}

export async function buildSnapshotPair(
  repositoryRoot: string,
  git: GitClient,
  signal?: AbortSignal,
): Promise<SnapshotPair> {
  const options = signal === undefined ? {} : { signal };
  const unresolved = await git.run(["ls-files", "--unmerged", "-z"], options);
  if (unresolved.stdout !== "") {
    throw new SnapshotError(
      "UNRESOLVED_INDEX",
      "Zedbee cannot build a staged snapshot while the index has unresolved entries.",
    );
  }

  const root = await createOwnedSnapshotRoot();
  try {
    const stagedEntries = parseStagedEntries(
      (await git.run(["ls-files", "--stage", "-z"], options)).stdout,
    );
    validateEntryPaths(repositoryRoot, stagedEntries);
    const intentToAddPaths = parseIntentToAddPaths(
      (await git.run(["ls-files", "--debug", "-z"], options)).stdout,
    );
    const selectedEntries = stagedEntries.filter(
      (entry) => !intentToAddPaths.has(entry.path),
    );
    const symlinkPaths = selectedEntries
      .filter((entry) => entry.mode === "120000")
      .map((entry) => entry.path);
    const unsupportedEntries = await materializeEntries(
      git,
      selectedEntries,
      root.targetDir,
      true,
      signal,
    );

    const head = await git.tryRun(["rev-parse", "--verify", "HEAD"], options);
    const baselineRef = head.exitCode === 0 ? "HEAD" : null;
    let baselineUnsupportedEntries: readonly UnsupportedIndexEntry[] = [];
    let baselineSymlinkPaths: readonly string[] = [];
    if (baselineRef === "HEAD") {
      const baselineEntries = await readCommitEntries(
        repositoryRoot,
        git,
        "HEAD",
        signal,
      );
      baselineUnsupportedEntries = await materializeEntries(
        git,
        baselineEntries,
        root.baselineDir,
        true,
        signal,
      );
      baselineSymlinkPaths = baselineEntries
        .filter((entry) => entry.mode === "120000")
        .map((entry) => entry.path);
    }
    return {
      baselineDir: root.baselineDir,
      targetDir: root.targetDir,
      baselineRef,
      targetRef: "index",
      baselineUnsupportedEntries,
      baselineSymlinkPaths,
      symlinkPaths,
      unsupportedEntries,
      cleanup: root.cleanup,
    };
  } catch (error) {
    return cleanupConstructionFailure(root, error);
  }
}
