import { posix } from "node:path";

/** A text Bun lockfile supersedes only the legacy lock in the same project. */
export function analyzableLockfiles(
  lockfiles: readonly string[],
): readonly string[] {
  const available = new Set(lockfiles);
  return lockfiles.filter(
    (path) =>
      posix.basename(path) !== "bun.lockb" ||
      !available.has(posix.join(posix.dirname(path), "bun.lock")),
  );
}
