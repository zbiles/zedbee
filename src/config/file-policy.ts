import { baselineRenameMap } from "../git/baseline-renames.js";
import ignore from "ignore";
import picomatch from "picomatch";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import type { ChangeSet } from "../git/change-set.js";
import type {
  CheckId,
  PathExclusion,
  ResolvedCheckPolicies,
  ResolvedCheckPolicyPatch,
  ResolvedConfig,
} from "./schema.js";
import {
  assertEffectiveFormattingPolicy,
  mergePolicyPatch,
} from "./target-policy.js";

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
  alternatePath?: (path: string, side: SnapshotSide) => string,
): FilePolicyResolver {
  const renames = baselineRenameMap(changeSet);
  const overrides = config.overrides.map((override) => ({
    checks: override.checks,
    matches: toMatchers(override.files),
    excludes: toMatchers(override.excludeFiles ?? []),
  }));
  const pathExclusions = config.pathExclusions.map((exclusion) => {
    if (exclusion.syntax === "gitignore") {
      const rules = ignore().add([...exclusion.files]);
      const prefix = exclusion.basePath === "." ? "" : `${exclusion.basePath}/`;
      return {
        exclusion,
        matches: (path: string) =>
          path.startsWith(prefix) &&
          path.length > prefix.length &&
          rules.ignores(path.slice(prefix.length)),
      };
    }
    const patterns = toMatchers(exclusion.files);
    return {
      exclusion,
      matches: (path: string) => patterns.some((match) => match(path)),
    };
  });

  const resolve = <K extends CheckId>(
    checkId: K,
    repositoryPath: string,
    side: SnapshotSide,
  ): Readonly<ResolvedCheckPolicies[K]> => {
    const targetPath = normalizeTargetPath(renames, repositoryPath, side);
    const alternate = alternatePath?.(targetPath, side);
    const paths =
      alternate !== undefined && alternate !== targetPath
        ? [targetPath, alternate]
        : [targetPath];
    let policy = mergePolicyPatch(config.checks[checkId], {}) as Readonly<
      ResolvedCheckPolicies[K]
    >;

    const matched: ResolvedCheckPolicyPatch[] = [];
    for (const override of overrides) {
      const patch = override.checks[checkId];
      if (
        patch === undefined ||
        !override.matches.some((matches) => paths.some(matches)) ||
        override.excludes.some((matches) => paths.some(matches))
      ) {
        continue;
      }
      matched.push(patch);
    }
    if (checkId === "formatting") {
      assertEffectiveFormattingPolicy(config, matched);
    }
    for (const patch of matched) {
      policy = mergePolicyPatch(policy, patch);
    }

    for (const exclusion of pathExclusions) {
      if (
        !exclusion.exclusion.checks.includes(checkId) ||
        !paths.some(exclusion.matches)
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
    const alternate = alternatePath?.(targetPath, side);
    const paths =
      alternate !== undefined && alternate !== targetPath
        ? [targetPath, alternate]
        : [targetPath];
    return Object.freeze(
      pathExclusions
        .filter(({ matches }) => paths.some(matches))
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
