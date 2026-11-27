import { isAbsolute, posix, relative, resolve, sep } from "node:path";

export interface WorkspaceDirectoryAlias {
  readonly relativeRoot: string;
  readonly canonicalRelativeRoot: string;
}

/** The selected snapshot, not a mutable checkout symlink, establishes the
 * physical installation location for a declared linked project. */
export function physicalWorkspaceRelativePath(
  path: string,
  alias?: WorkspaceDirectoryAlias,
): string {
  if (alias === undefined) return path;
  const normalized = path.split(sep).join("/");
  if (
    normalized !== alias.relativeRoot &&
    !normalized.startsWith(`${alias.relativeRoot}/`)
  )
    return path;
  return posix.join(
    alias.canonicalRelativeRoot,
    normalized.slice(alias.relativeRoot.length),
  );
}

/** The package lookup for a snapshot source starts at its live counterpart. */
export function dependencyResolutionContainingFile(
  repositoryRoot: string,
  snapshotRoot: string,
  containingFile: string,
  alias?: WorkspaceDirectoryAlias,
): string {
  const path = relative(snapshotRoot, resolve(containingFile));
  return resolve(
    repositoryRoot,
    isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)
      ? "src/index.ts"
      : physicalWorkspaceRelativePath(path, alias),
  );
}
