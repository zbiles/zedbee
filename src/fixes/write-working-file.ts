import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
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

function unsafePath(): Error {
  return new Error("Zedbee refused an unsafe working-file path.");
}

function changedFile(): Error {
  return new Error("Zedbee refused a changed working file.");
}

function digest(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function sameIdentity(
  left: WorkingFileIdentity,
  right: WorkingFileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function validateTarget(
  repositoryRoot: string,
  file: string,
  expectedIdentity: WorkingFileIdentity | undefined,
): Promise<{ path: string; mode: number; identity: WorkingFileIdentity }> {
  let normalized: string;
  try {
    normalized = normalizeRepositoryRelativePath(file);
  } catch {
    throw unsafePath();
  }
  const root = resolve(repositoryRoot);
  const target = resolve(root, normalized);
  if (!contained(root, target)) throw unsafePath();
  let rootState;
  try {
    rootState = await lstat(root, { bigint: true });
  } catch {
    throw unsafePath();
  }
  if (rootState.isSymbolicLink() || !rootState.isDirectory())
    throw unsafePath();

  const ancestors = normalized.split("/");
  let current = root;
  for (const ancestor of ancestors.slice(0, -1)) {
    current = resolve(current, ancestor);
    let state;
    try {
      state = await lstat(current, { bigint: true });
    } catch {
      throw unsafePath();
    }
    if (state.isSymbolicLink() || !state.isDirectory()) throw unsafePath();
  }

  let state;
  try {
    state = await lstat(target, { bigint: true });
  } catch {
    throw unsafePath();
  }
  if (state.isSymbolicLink() || !state.isFile()) throw unsafePath();
  const identity = { device: state.dev, inode: state.ino };
  if (
    expectedIdentity !== undefined &&
    !sameIdentity(identity, expectedIdentity)
  ) {
    throw changedFile();
  }
  return { path: target, mode: Number(state.mode & 0o777n), identity };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Replaces one existing regular working file with a synced same-directory file. */
export async function writeWorkingFile(
  request: WriteWorkingFileRequest,
): Promise<void> {
  if (typeof request.source !== "string")
    throw new TypeError("Expected source");
  const target = await validateTarget(
    request.repositoryRoot,
    request.file,
    request.expectedIdentity,
  );
  const directory = dirname(target.path);
  const temporary = resolve(directory, `.zedbee-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      target.mode,
    );
    if (request.dependencies?.write === undefined) {
      await handle.writeFile(request.source, "utf8");
    } else {
      await request.dependencies.write(handle, request.source);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, target.mode);
    await validateTarget(
      request.repositoryRoot,
      request.file,
      request.expectedIdentity ?? target.identity,
    );
    if (
      request.expectedSha256 !== undefined &&
      digest(await readFile(target.path, "utf8")) !== request.expectedSha256
    ) {
      throw changedFile();
    }
    await rename(temporary, target.path);
    renamed = true;
    if (process.platform !== "win32") {
      await (request.dependencies?.syncDirectory ?? syncDirectory)(directory);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}
