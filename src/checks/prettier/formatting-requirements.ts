import type { FilePolicyResolver } from "../../config/file-policy.js";
import type { RepositoryInspection } from "../../inspection/types.js";
import { owningProjectRoot } from "./project-engine.js";
import { compareCodeUnits } from "../../core/compare.js";

/** Discover the effective formatting owners from selected snapshot paths, not checkout manifests. */
export function formattingRequirements(
  inspection: RepositoryInspection,
  policyForFile: FilePolicyResolver,
  additionalPaths: readonly string[] = [],
): { readonly projectRoots: readonly string[]; readonly managed: boolean } {
  const paths = new Set([
    ...inspection.workspaces.flatMap((workspace) => [
      workspace.manifestPath,
      ...workspace.sourceFiles,
      ...workspace.tsconfigPaths,
    ]),
    ...additionalPaths,
  ]);
  if (paths.size === 0) paths.add("package.json");
  const projectRoots = new Set<string>();
  let managed = false;
  for (const path of paths) {
    const policy = policyForFile("formatting", path, "target");
    if (policy.severity === "off") continue;
    if (policy.engine === "project") {
      projectRoots.add(owningProjectRoot(inspection.workspaces, path));
    } else managed = true;
  }
  return { projectRoots: [...projectRoots].sort(compareCodeUnits), managed };
}
