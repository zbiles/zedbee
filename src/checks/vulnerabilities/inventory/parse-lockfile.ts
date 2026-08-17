import { posix } from "node:path";
import { normalizeRepositoryRelativePath } from "../../../attribution/fingerprint.js";
import { readContainedFile } from "../../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../../inspection/snapshot-registry.js";
import type { RepositoryInspection } from "../../../inspection/types.js";
import { inventoryError, LockfileInventoryError } from "./errors.js";
import { parseNpmLockfile } from "./parse-npm.js";
import { parsePnpmLockfile } from "./parse-pnpm.js";
import { parseYarnLockfile } from "./parse-yarn.js";
import { parseBunLockfile } from "./parse-bun.js";
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
  if (filename === "bun.lockb") {
    throw inventoryError(
      "LOCKFILE_UNSUPPORTED_BINARY",
      "Bun's legacy binary lockfile cannot be analyzed safely.",
      "Run bun install --save-text-lockfile --frozen-lockfile --lockfile-only, then remove bun.lockb.",
    );
  }
  if (
    filename !== "package-lock.json" &&
    filename !== "npm-shrinkwrap.json" &&
    filename !== "pnpm-lock.yaml" &&
    filename !== "yarn.lock" &&
    filename !== "bun.lock"
  ) {
    throw inventoryError(
      "LOCKFILE_UNSUPPORTED",
      "The discovered lockfile format is not supported by this parser.",
    );
  }
  try {
    const registry = await captureSnapshotRegistry(inspection.snapshotRoot);
    const contents = await readContainedFile(registry, lockfilePath);
    if (filename === "pnpm-lock.yaml") return parsePnpmLockfile(contents, lockfilePath);
    if (filename === "yarn.lock") return parseYarnLockfile(contents, lockfilePath);
    if (filename === "bun.lock") return parseBunLockfile(contents, lockfilePath);
    return parseNpmLockfile(contents, lockfilePath);
  } catch (error) {
    if (error instanceof LockfileInventoryError) throw error;
    throw inventoryError(
      "LOCKFILE_INVALID",
      "Zedbee could not safely read the discovered lockfile.",
    );
  }
}
