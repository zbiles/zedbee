import { lstatSync, realpathSync } from "node:fs";
import {
  lstat as lstatAsync,
  realpath as realpathAsync,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";

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

function isContainedBy(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== "" &&
    !isAbsolute(pathFromParent) &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`)
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
  canonicalTempRoot: string,
  directory: boolean,
): ValidatedSnapshotPath {
  if (
    !isAbsolute(path) ||
    path !== canonicalPath ||
    !directory ||
    !isContainedBy(canonicalTempRoot, path) ||
    !basename(path).startsWith(SNAPSHOT_PREFIX)
  ) {
    return invalidSnapshotPath();
  }
  return path as ValidatedSnapshotPath;
}

export async function validateSnapshotPath(
  path: string,
): Promise<ValidatedSnapshotPath> {
  if (!isAbsolute(path)) {
    return invalidSnapshotPath();
  }
  const [canonicalTempRoot, canonicalPath, metadata] = await Promise.all([
    realpathAsync(tmpdir()),
    realpathAsync(path),
    lstatAsync(path),
  ]);
  return validateCanonicalSnapshotPath(
    path,
    canonicalPath,
    canonicalTempRoot,
    metadata.isDirectory(),
  );
}

export function validateReportableSnapshotPath(
  path: string,
): ValidatedSnapshotPath {
  if (!isAbsolute(path)) {
    return invalidSnapshotPath();
  }
  return validateCanonicalSnapshotPath(
    path,
    realpathSync(path),
    realpathSync(tmpdir()),
    lstatSync(path).isDirectory(),
  );
}
