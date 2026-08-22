import picomatch from "picomatch";
import type { CheckTarget } from "../checks/adapter.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../inspection/types.js";
import type { CheckId, ResolvedCheckPolicy, ResolvedConfig } from "./schema.js";
import type { ResolvedCheckPolicyPatch } from "./schema.js";
import { freezeRuleSettings } from "../checks/eslint/rule-settings.js";

function policyCandidates(
  target: CheckTarget,
  inspection: RepositoryInspection,
): readonly string[] {
  if (target.kind === "repository" && target.relativeRoot !== ".") {
    throw new Error(
      "Repository targets must use the inspected repository root",
    );
  }
  if (target.kind === "repository") {
    return inspection.workspaces.length === 0
      ? ["."]
      : inspection.workspaces.flatMap(workspaceCandidates);
  }
  const workspace = inspection.workspaces.find(
    ({ relativeRoot }) => relativeRoot === target.relativeRoot,
  );
  if (workspace === undefined) {
    throw new Error(`Target ${target.id} is not an inspected workspace`);
  }
  return workspaceCandidates(workspace);
}

function workspaceCandidates(
  workspace: WorkspaceInspection,
): readonly string[] {
  return [
    workspace.relativeRoot,
    workspace.manifestPath,
    ...workspace.sourceFiles,
    ...workspace.tsconfigPaths,
  ];
}

export function resolveTargetPolicy(
  config: ResolvedConfig,
  checkId: CheckId,
  target: CheckTarget,
  inspection: RepositoryInspection,
): ResolvedCheckPolicy {
  let policy: ResolvedCheckPolicy = { ...config.checks[checkId] };
  const candidates = policyCandidates(target, inspection);

  for (const override of config.overrides) {
    const patch = override.checks[checkId];
    if (patch === undefined) continue;
    if (patch.onUnavailable !== undefined) {
      throw new TypeError(
        "Vulnerability availability policy cannot be overridden by file scope",
      );
    }
    const matches = override.files.some((pattern) => {
      const isMatch = picomatch(pattern, { dot: true });
      return candidates.some((candidate) => isMatch(candidate));
    });
    if (matches) policy = mergePolicyPatch(policy, patch);
  }

  return policy;
}

function mergePolicyPatch(
  policy: ResolvedCheckPolicy,
  patch: ResolvedCheckPolicyPatch,
): ResolvedCheckPolicy {
  const merged = { ...policy, ...patch };
  if ("settings" in policy && patch.settings !== undefined) {
    merged.settings = Object.freeze({ ...policy.settings, ...patch.settings });
  }
  if ("rules" in policy && patch.rules !== undefined) {
    merged.rules = freezeRuleSettings({ ...policy.rules, ...patch.rules });
  }
  return Object.freeze(merged) as ResolvedCheckPolicy;
}
