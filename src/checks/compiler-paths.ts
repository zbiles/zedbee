import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import type { InspectionContext } from "./adapter.js";
import { memoizeCompilerDecision } from "./compiler-decision-cache.js";
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

/** The managed compilers do not consume conventional OpenAPI documentation.
 * Callers must check captured source, configuration and dependency inputs first. */
export const ordinaryOpenApiEdits = memoizeCompilerDecision(
  async (context: InspectionContext): Promise<ReadonlySet<string>> => {
    const paths = new Set<string>();
    for (const path of ["docs/openapi.yaml", "docs/openapi.yml"]) {
      const change = context.changeSet.files.get(path);
      if (
        change?.status !== "modified" ||
        [...context.changeSet.files.values()].some(
          ({ previousPath }) => previousPath === path,
        )
      )
        continue;

      // An unchanged alias can expose YAML contents as a .ts or .json input.
      // Check both snapshots for aliases, file type and matching mode.
      const modes = await Promise.all(
        [context.baselineInspection, context.targetInspection].map(
          async ({ snapshotRoot, fileSymlinkTargets }) => {
            if (fileSymlinkTargets?.includes(path) !== false) return undefined;
            try {
              const directory = await lstat(join(snapshotRoot, "docs"));
              if (!directory.isDirectory()) return undefined;
              const file = await lstat(join(snapshotRoot, path));
              return file.isFile() ? file.mode : undefined;
            } catch {
              return undefined;
            }
          },
        ),
      );
      context.signal?.throwIfAborted();
      if (modes[0] !== undefined && modes[0] === modes[1]) paths.add(path);
    }
    return paths;
  },
);

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
