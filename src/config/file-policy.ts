import picomatch from "picomatch";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import type { ChangeSet } from "../git/change-set.js";
import type {
  CheckId,
  ResolvedCheckPolicies,
  ResolvedConfig,
} from "./schema.js";
import { mergePolicyPatch } from "./target-policy.js";

export type SnapshotSide = "baseline" | "target";

export type FilePolicyResolver = <K extends CheckId>(
  checkId: K,
  repositoryPath: string,
  side: SnapshotSide,
) => Readonly<ResolvedCheckPolicies[K]>;

function baselineRenameMap(changeSet: ChangeSet): ReadonlyMap<string, string> {
  const renames = new Map<string, string>();
  for (const file of changeSet.files.values()) {
    if (file.status !== "renamed" || file.previousPath === undefined) continue;
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

export function createFilePolicyResolver(
  config: ResolvedConfig,
  changeSet: ChangeSet,
): FilePolicyResolver {
  const renames = baselineRenameMap(changeSet);
  const overrides = config.overrides.map((override) => ({
    checks: override.checks,
    matches: override.files.map((pattern) => picomatch(pattern, { dot: true })),
  }));

  const resolve: FilePolicyResolver = <K extends CheckId>(
    checkId: K,
    repositoryPath: string,
    side: SnapshotSide,
  ): Readonly<ResolvedCheckPolicies[K]> => {
    const normalizedPath = normalizeRepositoryRelativePath(repositoryPath);
    const targetPath =
      side === "baseline"
        ? (renames.get(normalizedPath) ?? normalizedPath)
        : normalizedPath;
    let policy = mergePolicyPatch(config.checks[checkId], {});

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
    return policy as Readonly<ResolvedCheckPolicies[K]>;
  };

  return Object.freeze(resolve);
}
