import { lstatSync, realpathSync, statSync } from "node:fs";
import {
  lstat as lstatAsync,
  realpath as realpathAsync,
  stat as statAsync,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";

export const SNAPSHOT_PREFIX = "zedbee-snapshot-";

declare const validatedSnapshotPath: unique symbol;
export type ValidatedSnapshotPath = string & {
  readonly [validatedSnapshotPath]: true;
};

export type SnapshotErrorCode =
  | "INVALID_INDEX_PATH"
  | "INVALID_TEMP_PATH"
  | "UNRESOLVED_INDEX"
  | "SNAPSHOT_CONSTRUCTION_FAILED";

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;

  constructor(code: SnapshotErrorCode, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameDirectory(
  leftPath: string,
  rightPath: string,
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return (
    samePath(leftPath, rightPath) ||
    (left.ino !== 0 && left.dev === right.dev && left.ino === right.ino)
  );
}

function invalidSnapshotPath(): never {
  throw new SnapshotError(
    "INVALID_TEMP_PATH",
    "Zedbee refused to use a temporary snapshot path outside its managed directory.",
  );
}

function validateCanonicalSnapshotPath(
  path: string,
  canonicalPath: string,
  parentIsTempRoot: boolean,
  directory: boolean,
): ValidatedSnapshotPath {
  if (
    !isAbsolute(path) ||
    !isAbsolute(canonicalPath) ||
    !directory ||
    !parentIsTempRoot ||
    !basename(canonicalPath).startsWith(SNAPSHOT_PREFIX)
  ) {
    return invalidSnapshotPath();
  }
  return canonicalPath as ValidatedSnapshotPath;
}

export async function validateSnapshotPath(
  path: string,
): Promise<ValidatedSnapshotPath> {
  if (!isAbsolute(path)) {
    return invalidSnapshotPath();
  }
  const [canonicalTempRoot, canonicalPath, metadata, tempMetadata] =
    await Promise.all([
      realpathAsync(tmpdir()),
      realpathAsync(path),
      lstatAsync(path),
      statAsync(tmpdir()),
    ]);
  const canonicalParent = dirname(canonicalPath);
  const parentMetadata = await statAsync(canonicalParent);
  return validateCanonicalSnapshotPath(
    path,
    canonicalPath,
    sameDirectory(
      canonicalTempRoot,
      canonicalParent,
      tempMetadata,
      parentMetadata,
    ),
    metadata.isDirectory(),
  );
}

export function validateReportableSnapshotPath(
  path: string,
): ValidatedSnapshotPath {
  if (!isAbsolute(path)) {
    return invalidSnapshotPath();
  }
  const canonicalPath = realpathSync(path);
  const canonicalTempRoot = realpathSync(tmpdir());
  const canonicalParent = dirname(canonicalPath);
  return validateCanonicalSnapshotPath(
    path,
    canonicalPath,
    sameDirectory(
      canonicalTempRoot,
      canonicalParent,
      statSync(tmpdir()),
      statSync(canonicalParent),
    ),
    lstatSync(path).isDirectory(),
  );
}
