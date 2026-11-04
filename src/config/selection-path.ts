import * as nativePath from "node:path";

type PathOperations = Pick<
  typeof nativePath,
  "resolve" | "relative" | "isAbsolute" | "extname" | "sep"
>;

/** The same containment policy is used by commands and selected-source loaders. */
export function repositoryConfigPath(
  repositoryRoot: string,
  requested: string,
  paths: PathOperations = nativePath,
): string | undefined {
  const candidate = paths.resolve(repositoryRoot, requested);
  const fromRoot = paths.relative(repositoryRoot, candidate);
  if (
    !fromRoot ||
    paths.isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${paths.sep}`)
  )
    return undefined;
  return fromRoot.split(paths.sep).join("/");
}

export function validConfigPath(
  repositoryRoot: string,
  requested: string,
  paths: PathOperations = nativePath,
): string | undefined {
  const candidate = paths.resolve(repositoryRoot, requested);
  return paths.extname(candidate) === ".jsonc" &&
    repositoryConfigPath(repositoryRoot, candidate, paths) !== undefined
    ? candidate
    : undefined;
}
