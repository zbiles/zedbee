import { posix } from "node:path";

export const WINDOWS_PATH = /^[A-Za-z]:[/\\]/u;
export const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

export function isContainedImportSpecifier(
  sourcePath: string,
  specifier: string,
): boolean {
  if (
    specifier.includes("\\") ||
    posix.isAbsolute(specifier) ||
    WINDOWS_PATH.test(specifier) ||
    (URL_SCHEME.test(specifier) &&
      !specifier.startsWith("node:") &&
      !specifier.startsWith("bun:"))
  )
    return false;
  if (!specifier.startsWith(".")) return true;
  const resolved = posix.normalize(
    posix.join(posix.dirname(sourcePath), specifier),
  );
  return resolved !== ".." && !resolved.startsWith("../");
}
