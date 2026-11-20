import { isAbsolute, relative, resolve, sep } from "node:path";

/** The package lookup for a snapshot source starts at its live counterpart. */
export function dependencyResolutionContainingFile(
  repositoryRoot: string,
  snapshotRoot: string,
  containingFile: string,
): string {
  const path = relative(snapshotRoot, resolve(containingFile));
  return resolve(
    repositoryRoot,
    isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)
      ? "src/index.ts"
      : path,
  );
}
