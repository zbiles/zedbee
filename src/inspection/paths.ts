import { isAbsolute, relative, sep } from "node:path";
import { RepositoryInspectionError } from "./types.js";

export function normalizeRepositoryPath(path: string): string {
  return path.split(sep).join("/");
}

export function isContainedPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

export function unsafePath(): RepositoryInspectionError {
  return new RepositoryInspectionError(
    "UNSAFE_SNAPSHOT_PATH",
    "Zedbee refused a path outside the snapshot.",
  );
}
