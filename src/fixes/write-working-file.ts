import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";

export interface WorkingFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface DirectoryState {
  readonly path: string;
  readonly identity: WorkingFileIdentity;
}

interface TargetState {
  readonly path: string;
  readonly mode: number;
  readonly identity: WorkingFileIdentity;
  readonly ancestors: readonly DirectoryState[];
}

export class CommittedWriteError extends Error {
  readonly file: string;

  constructor(file: string) {
    super("Zedbee replaced the working file but could not sync its directory.");
    this.name = "CommittedWriteError";
    this.file = file;
    Object.freeze(this);
  }
}

export interface WriteWorkingFileDependencies {
  write?(handle: FileHandle, source: string): Promise<void>;
  syncDirectory?(directory: string): Promise<void>;
}

export interface WriteWorkingFileRequest {
  readonly repositoryRoot: string;
  readonly file: string;
  readonly source: string;
  readonly expectedIdentity?: WorkingFileIdentity;
  readonly expectedSha256?: string;
  readonly dependencies?: WriteWorkingFileDependencies;
}

const activeTargets = new Set<string>();

function unsafePath(): Error {
  return new Error("Zedbee refused an unsafe working-file path.");
}

function changedFile(): Error {
  return new Error("Zedbee refused a changed working file.");
}

function duplicateTarget(): Error {
  return new Error("Zedbee refused a duplicate in-flight working-file target.");
}

function digest(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function identity(state: { dev: bigint; ino: bigint }): WorkingFileIdentity {
  return { device: state.dev, inode: state.ino };
}

function sameIdentity(
  left: WorkingFileIdentity,
  right: WorkingFileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function validateAncestors(
  ancestors: readonly DirectoryState[],
): Promise<void> {
  for (const ancestor of ancestors) {
    let state;
    try {
      state = await lstat(ancestor.path, { bigint: true });
    } catch {
      throw unsafePath();
    }
    if (state.isSymbolicLink() || !state.isDirectory()) throw unsafePath();
    if (!sameIdentity(identity(state), ancestor.identity)) throw changedFile();
  }
}

async function validateTarget(
  repositoryRoot: string,
  file: string,
  expectedIdentity: WorkingFileIdentity | undefined,
  expectedAncestors: readonly DirectoryState[] | undefined,
): Promise<TargetState> {
  let normalized: string;
  try {
    normalized = normalizeRepositoryRelativePath(file);
  } catch {
    throw unsafePath();
  }
  const root = resolve(repositoryRoot);
  const target = resolve(root, normalized);
  if (!contained(root, target)) throw unsafePath();

  const paths = [root];
  let current = root;
  for (const ancestor of normalized.split("/").slice(0, -1)) {
    current = resolve(current, ancestor);
    paths.push(current);
  }
  const ancestors: DirectoryState[] = [];
  for (const path of paths) {
    let state;
    try {
      state = await lstat(path, { bigint: true });
    } catch {
      throw unsafePath();
    }
    if (state.isSymbolicLink() || !state.isDirectory()) throw unsafePath();
    ancestors.push({ path, identity: identity(state) });
  }
  if (expectedAncestors !== undefined) {
    if (expectedAncestors.length !== ancestors.length) throw changedFile();
    for (const [index, ancestor] of ancestors.entries()) {
      const expected = expectedAncestors[index];
      if (
        expected === undefined ||
        expected.path !== ancestor.path ||
        !sameIdentity(expected.identity, ancestor.identity)
      ) {
        throw changedFile();
      }
    }
  }

  let state;
  try {
    state = await lstat(target, { bigint: true });
  } catch {
    throw unsafePath();
  }
  if (state.isSymbolicLink() || !state.isFile()) throw unsafePath();
  const targetIdentity = identity(state);
  if (
    expectedIdentity !== undefined &&
    !sameIdentity(targetIdentity, expectedIdentity)
  ) {
    throw changedFile();
  }
  return {
    path: target,
    mode: Number(state.mode & 0o777n),
    identity: targetIdentity,
    ancestors: Object.freeze(ancestors),
  };
}

async function validatedTemporary(
  temporary: string,
  expectedIdentity: WorkingFileIdentity,
  ancestors: readonly DirectoryState[],
): Promise<void> {
  await validateAncestors(ancestors);
  let state;
  try {
    state = await lstat(temporary, { bigint: true });
  } catch {
    throw unsafePath();
  }
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    !sameIdentity(identity(state), expectedIdentity)
  ) {
    throw unsafePath();
  }
}

async function cleanupTemporary(
  temporary: string,
  temporaryIdentity: WorkingFileIdentity | undefined,
  ancestors: readonly DirectoryState[],
): Promise<void> {
  if (temporaryIdentity === undefined) return;
  try {
    await validatedTemporary(temporary, temporaryIdentity, ancestors);
    await unlink(temporary);
  } catch {
    // A changed ancestor or temporary path is intentionally left alone.
  }
}

/** Replaces one existing regular working file with a synced same-directory file. */
export async function writeWorkingFile(
  request: WriteWorkingFileRequest,
): Promise<void> {
  if (typeof request.source !== "string") {
    throw new TypeError("Expected source");
  }
  const target = await validateTarget(
    request.repositoryRoot,
    request.file,
    request.expectedIdentity,
    undefined,
  );
  if (activeTargets.has(target.path)) throw duplicateTarget();
  activeTargets.add(target.path);
  const directory = dirname(target.path);
  const temporary = resolve(directory, `.zedbee-${randomUUID()}.tmp`);
  let directoryHandle: FileHandle | undefined;
  let temporaryHandle: FileHandle | undefined;
  let temporaryIdentity: WorkingFileIdentity | undefined;
  let renamed = false;
  try {
    directoryHandle = await open(directory, constants.O_RDONLY);
    const openedDirectory = await directoryHandle.stat({ bigint: true });
    const expectedDirectory = target.ancestors.at(-1);
    if (
      expectedDirectory === undefined ||
      !openedDirectory.isDirectory() ||
      !sameIdentity(identity(openedDirectory), expectedDirectory.identity)
    ) {
      throw changedFile();
    }
    await validateAncestors(target.ancestors);
    temporaryHandle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      target.mode,
    );
    if (request.dependencies?.write === undefined) {
      await temporaryHandle.writeFile(request.source, "utf8");
    } else {
      await request.dependencies.write(temporaryHandle, request.source);
    }
    await temporaryHandle.chmod(target.mode);
    await temporaryHandle.sync();
    temporaryIdentity = identity(await temporaryHandle.stat({ bigint: true }));

    await validateTarget(
      request.repositoryRoot,
      request.file,
      request.expectedIdentity ?? target.identity,
      target.ancestors,
    );
    if (
      request.expectedSha256 !== undefined &&
      digest(await readFile(target.path, "utf8")) !== request.expectedSha256
    ) {
      throw changedFile();
    }
    await validatedTemporary(temporary, temporaryIdentity, target.ancestors);
    await rename(temporary, target.path);
    renamed = true;
    if (process.platform !== "win32") {
      try {
        if (request.dependencies?.syncDirectory === undefined) {
          await directoryHandle.sync();
        } else {
          await request.dependencies.syncDirectory(directory);
        }
      } catch {
        throw new CommittedWriteError(request.file);
      }
    }
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
    if (!renamed) {
      await cleanupTemporary(temporary, temporaryIdentity, target.ancestors);
    }
    activeTargets.delete(target.path);
  }
}
