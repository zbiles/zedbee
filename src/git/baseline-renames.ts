import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import type { ChangeSet } from "./change-set.js";

export function baselineRenameMap(
  changeSet: ChangeSet,
): ReadonlyMap<string, string> {
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
