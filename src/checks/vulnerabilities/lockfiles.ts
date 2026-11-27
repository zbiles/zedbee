export function analyzableLockfiles(
  lockfiles: readonly string[],
): readonly string[] {
  const hasTextBunLock = lockfiles.some(
    (path) => path.split("/").at(-1) === "bun.lock",
  );
  return lockfiles.filter(
    (path) => !(hasTextBunLock && path.split("/").at(-1) === "bun.lockb"),
  );
}
