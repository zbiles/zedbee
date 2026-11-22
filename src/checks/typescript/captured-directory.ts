import picomatch from "picomatch";
import { relative } from "node:path";

function pathMatcher(pattern: string): (path: string) => boolean {
  const normalized = pattern.replace(/\/+$/u, "");
  const exact = picomatch(pattern, { dot: true });
  const descendant = picomatch(`${normalized}/**/*`, { dot: true });
  return (path) => exact(path) || descendant(path);
}

export function filterCapturedCompilerFiles(
  paths: Iterable<string>,
  root: string,
  extensions: readonly string[],
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  depth: number | undefined,
): string[] {
  const include = (includes?.length ? includes : ["**/*"]).map(pathMatcher);
  const exclude = (excludes ?? []).map(pathMatcher);
  return [...paths].filter((path) => {
    const relativePath = relative(root, path).replaceAll("\\", "/");
    return (
      relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      (depth === undefined || relativePath.split("/").length - 1 <= depth) &&
      extensions.some((extension) => path.endsWith(extension)) &&
      include.some((match) => match(relativePath)) &&
      !exclude.some((match) => match(relativePath))
    );
  });
}
