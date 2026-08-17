import { posix } from "node:path";
import { normalizeRepositoryRelativePath } from "../../../attribution/fingerprint.js";
import { readContainedFile } from "../../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../../inspection/snapshot-registry.js";
import type { RepositoryInspection } from "../../../inspection/types.js";
import { inventoryError, LockfileInventoryError } from "./errors.js";
import { parseNpmLockfile } from "./parse-npm.js";
import type { DependencyInventory } from "./types.js";

export async function parseLockfileInventory(
  inspection: RepositoryInspection,
  repositoryPath: string,
): Promise<DependencyInventory> {
  let lockfilePath: string;
  try {
    lockfilePath = normalizeRepositoryRelativePath(repositoryPath);
  } catch {
    throw inventoryError(
      "LOCKFILE_NOT_DISCOVERED",
      "Zedbee refused a lockfile path outside the inspected snapshot.",
    );
  }
  if (!inspection.lockfiles.includes(lockfilePath)) {
    throw inventoryError(
      "LOCKFILE_NOT_DISCOVERED",
      "The requested lockfile was not discovered in the inspected snapshot.",
    );
  }
  const filename = posix.basename(lockfilePath);
  if (filename !== "package-lock.json" && filename !== "npm-shrinkwrap.json") {
    throw inventoryError(
      "LOCKFILE_UNSUPPORTED",
      "The discovered lockfile format is not supported by this parser.",
    );
  }
  try {
    const registry = await captureSnapshotRegistry(inspection.snapshotRoot);
    const contents = await readContainedFile(registry, lockfilePath);
    return parseNpmLockfile(contents, lockfilePath);
  } catch (error) {
    if (error instanceof LockfileInventoryError) throw error;
    throw inventoryError(
      "LOCKFILE_INVALID",
      "Zedbee could not safely read the discovered lockfile.",
    );
  }
}
