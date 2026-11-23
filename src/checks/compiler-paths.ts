import { posix } from "node:path";
import type { ChangeSet } from "../git/change-set.js";

export const COMPILER_SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
export const COMPILER_DEPENDENCY =
  /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.pnp\.(?:cjs|js|data\.json)|\.npmrc|\.yarnrc(?:\.yml)?)$/iu;
export const COMPILER_CONFIGURATION =
  /^(?:tsconfig(?:\.[^.]+)*\.json|jsconfig(?:\.[^.]+)*\.json|(?:zedbee|swarm)\.config\.[^.]+|\.(?:zedbee|swarm)(?:rc)?(?:\.[^.]+)?)$/iu;
const COMPILER_ORDINARY = /\.(?:py|pyi|md|markdown|rst|txt)$/iu;

export function isOrdinaryCompilerPath(path: string): boolean {
  const name = posix.basename(path).toLowerCase();
  return (
    name === ".gitignore" ||
    name === "pyproject.toml" ||
    COMPILER_ORDINARY.test(name)
  );
}

const changes = new WeakMap<ChangeSet, ReadonlySet<string>>();

export function changedCompilerPaths(
  changeSet: ChangeSet,
): ReadonlySet<string> {
  let paths = changes.get(changeSet);
  if (paths === undefined) {
    paths = new Set(
      [...changeSet.files.values()].flatMap(({ path, previousPath }) =>
        previousPath === undefined ? [path] : [path, previousPath],
      ),
    );
    changes.set(changeSet, paths);
  }
  return paths;
}
