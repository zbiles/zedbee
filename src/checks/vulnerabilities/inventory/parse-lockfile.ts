import { posix } from "node:path";
import {
  ContainedFileSizeError,
  readContainedFile,
} from "../../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../../inspection/snapshot-registry.js";
import type { RepositoryInspection } from "../../../inspection/types.js";
import { inventoryError, LockfileInventoryError } from "./errors.js";
import { parseNpmLockfile } from "./parse-npm.js";
import { parsePnpmLockfile } from "./parse-pnpm.js";
import { parseYarnLockfile } from "./parse-yarn.js";
import { parseBunLockfile } from "./parse-bun.js";
import { MAX_LOCKFILE_BYTES } from "./limits.js";
import { normalizeLockfilePath } from "./normalize.js";
import type { DependencyInventory } from "./types.js";

const LOCKFILE_PARSERS: Readonly<
  Record<
    string,
    (contents: string, repositoryPath: string) => DependencyInventory
  >
> = Object.freeze({
  "package-lock.json": parseNpmLockfile,
  "npm-shrinkwrap.json": parseNpmLockfile,
  "pnpm-lock.yaml": parsePnpmLockfile,
  "yarn.lock": parseYarnLockfile,
  "bun.lock": parseBunLockfile,
});

export async function parseLockfileInventory(
  inspection: RepositoryInspection,
  repositoryPath: string,
): Promise<DependencyInventory> {
  const lockfilePath = normalizeLockfilePath(repositoryPath);
  if (!inspection.lockfiles.includes(lockfilePath)) {
    throw inventoryError(
      "LOCKFILE_NOT_DISCOVERED",
      "The requested lockfile was not discovered in the inspected snapshot.",
    );
  }
  const filename = posix.basename(lockfilePath);
  if (filename === "bun.lockb") {
    throw inventoryError(
      "LOCKFILE_UNSUPPORTED_BINARY",
      "Bun's legacy binary lockfile cannot be analyzed safely.",
      "Run bun install --save-text-lockfile --frozen-lockfile --lockfile-only, then remove bun.lockb.",
    );
  }
  const parse = Object.hasOwn(LOCKFILE_PARSERS, filename)
    ? LOCKFILE_PARSERS[filename]
    : undefined;
  if (parse === undefined) {
    throw inventoryError(
      "LOCKFILE_UNSUPPORTED",
      "The discovered lockfile format is not supported by this parser.",
    );
  }
  try {
    const registry = await captureSnapshotRegistry(inspection.snapshotRoot, [
      lockfilePath,
    ]);
    const contents = await readContainedFile(registry, lockfilePath, {
      maxBytes: MAX_LOCKFILE_BYTES,
    });
    return parse(contents, lockfilePath);
  } catch (error) {
    if (error instanceof LockfileInventoryError) throw error;
    if (error instanceof ContainedFileSizeError) {
      throw inventoryError(
        "LOCKFILE_LIMIT_EXCEEDED",
        "The lockfile exceeds Zedbee's file-size safety limit.",
      );
    }
    throw inventoryError(
      "LOCKFILE_INVALID",
      "Zedbee could not safely read the discovered lockfile.",
    );
  }
}
