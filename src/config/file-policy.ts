import picomatch from "picomatch";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import type { ChangeSet } from "../git/change-set.js";
import type {
  CheckId,
  PathExclusion,
  ResolvedCheckPolicies,
  ResolvedConfig,
} from "./schema.js";
import { mergePolicyPatch } from "./target-policy.js";

export type SnapshotSide = "baseline" | "target";

export interface FilePolicyResolver {
  <K extends CheckId>(
    checkId: K,
    repositoryPath: string,
    side: SnapshotSide,
  ): Readonly<ResolvedCheckPolicies[K]>;
  pathExclusionsForFile?: <K extends CheckId>(
    checkId: K,
    repositoryPath: string,
    side: SnapshotSide,
  ) => readonly PathExclusion[];
  pathExclusionsForPath?: (
    repositoryPath: string,
    side: SnapshotSide,
  ) => readonly PathExclusion[];
}

function toMatchers(
  patterns: readonly string[],
): readonly ((path: string) => boolean)[] {
  return patterns.map((pattern) => picomatch(pattern, { dot: true }));
}

function baselineRenameMap(changeSet: ChangeSet): ReadonlyMap<string, string> {
  const renames = new Map<string, string>();
  for (const file of changeSet.files.values()) {
    if (file.status !== "renamed") continue;
    if (file.previousPath === undefined) {
      throw new TypeError("Expected a renamed file to have a baseline path");
    }
    const baselinePath = normalizeRepositoryRelativePath(file.previousPath);
    const targetPath = normalizeRepositoryRelativePath(file.path);
    const existing = renames.get(baselinePath);
    if (existing !== undefined && existing !== targetPath) {
      throw new TypeError(
        "Expected each baseline path to have one target path",
      );
    }
    renames.set(baselinePath, targetPath);
  }
  return renames;
}

function normalizeTargetPath(
  renames: ReadonlyMap<string, string>,
  repositoryPath: string,
  side: SnapshotSide,
): string {
  const normalizedPath = normalizeRepositoryRelativePath(repositoryPath);
  return side === "baseline"
    ? (renames.get(normalizedPath) ?? normalizedPath)
    : normalizedPath;
}

export function createFilePolicyResolver(
  config: ResolvedConfig,
  changeSet: ChangeSet,
): FilePolicyResolver {
  const renames = baselineRenameMap(changeSet);
  const overrides = config.overrides.map((override) => ({
    checks: override.checks,
    matches: toMatchers(override.files),
  }));
  const pathExclusions = config.pathExclusions.map((exclusion) => ({
    exclusion,
    filesMatchers: toMatchers(exclusion.files),
  }));

  const resolve = <K extends CheckId>(
    checkId: K,
    repositoryPath: string,
    side: SnapshotSide,
  ): Readonly<ResolvedCheckPolicies[K]> => {
    const targetPath = normalizeTargetPath(renames, repositoryPath, side);
    let policy = mergePolicyPatch(config.checks[checkId], {}) as Readonly<
      ResolvedCheckPolicies[K]
    >;

    for (const override of overrides) {
      const patch = override.checks[checkId];
      if (
        patch === undefined ||
        !override.matches.some((matches) => matches(targetPath))
      ) {
        continue;
      }
      policy = mergePolicyPatch(policy, patch);
    }

    for (const exclusion of pathExclusions) {
      if (
        !exclusion.exclusion.checks.includes(checkId) ||
        !exclusion.filesMatchers.some((matches) => matches(targetPath))
      ) {
        continue;
      }
      return { ...policy, severity: "off" };
    }

    return policy as Readonly<ResolvedCheckPolicies[K]>;
  };

  resolve.pathExclusionsForPath = (
    repositoryPath: string,
    side: SnapshotSide,
  ): readonly PathExclusion[] => {
    const targetPath = normalizeTargetPath(renames, repositoryPath, side);
    return Object.freeze(
      pathExclusions
        .filter(({ filesMatchers }) =>
          filesMatchers.some((matches) => matches(targetPath)),
        )
        .map(({ exclusion }) => exclusion),
    );
  };

  resolve.pathExclusionsForFile = <K extends CheckId>(
    checkId: K,
    repositoryPath: string,
    side: SnapshotSide,
  ): readonly PathExclusion[] => {
    return Object.freeze(
      (resolve.pathExclusionsForPath?.(repositoryPath, side) ?? []).filter(
        ({ checks }) => checks.includes(checkId),
      ),
    );
  };

  return Object.freeze(resolve);
}
