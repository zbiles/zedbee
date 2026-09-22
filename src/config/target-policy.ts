import picomatch from "picomatch";
import type { CheckTarget } from "../checks/adapter.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../inspection/types.js";
import type { CheckId, ResolvedCheckPolicy, ResolvedConfig } from "./schema.js";
import type { ResolvedCheckPolicies } from "./schema.js";
import type { ResolvedCheckPolicyPatch } from "./schema.js";
import { freezeRuleSettings } from "../checks/eslint/freeze-rule-settings.js";

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

/**
 * Validates the effective formatting engine/settings combination after ordered
 * per-file override merging. Root-level and same-object conflicts are rejected
 * at parse time; this closes ordered override combinations in which one
 * matching override selects the project engine and a later one reintroduces
 * managed settings (or vice versa).
 */
export function assertEffectiveFormattingPolicy(
  config: ResolvedConfig,
  patches: readonly ResolvedCheckPolicyPatch[],
): void {
  const root = config.checks.formatting;
  let engine = root.engine;
  let explicitSettings = Object.entries(
    config.configurationOrigins.formatting,
  ).some(
    ([key, origin]) =>
      key.startsWith("settings.") && origin.kind !== "profile",
  );
  for (const patch of patches) {
    if (patch.settings !== undefined) explicitSettings = true;
    if (patch.engine !== undefined) engine = patch.engine;
  }
  if (engine === "project" && explicitSettings) {
    throw new TypeError(
      'The effective formatting policy selects engine "project" while managed formatting settings still apply. Remove the managed settings from the repository policy or matching overrides.',
    );
  }
}

export function resolveTargetPolicy(
  config: ResolvedConfig,
  checkId: CheckId,
  target: CheckTarget,
  inspection: RepositoryInspection,
): ResolvedCheckPolicy {
  let policy: ResolvedCheckPolicy = { ...config.checks[checkId] };
  const candidates = policyCandidates(target, inspection);

  const matched: ResolvedCheckPolicyPatch[] = [];
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
    if (matches) matched.push(patch);
  }
  for (const patch of matched) {
    if (checkId === "formatting") {
      // A repository target can contain disjoint engine/settings scopes.
      // Preserve root behavior here; validate and merge behavior per file.
      const { engine: _engine, settings: _settings, ...targetPatch } = patch;
      policy = mergePolicyPatch(policy, targetPatch);
    } else {
      policy = mergePolicyPatch(policy, patch);
    }
  }

  return policy;
}

export function mergePolicyPatch<K extends CheckId>(
  policy: Readonly<ResolvedCheckPolicies[K]>,
  patch: ResolvedCheckPolicyPatch,
): Readonly<ResolvedCheckPolicies[K]>;
export function mergePolicyPatch(
  policy: Readonly<ResolvedCheckPolicy>,
  patch: ResolvedCheckPolicyPatch,
): Readonly<ResolvedCheckPolicy> {
  const merged: Record<string, unknown> = { ...policy, ...patch };
  if ("settings" in policy && patch.settings !== undefined) {
    merged.settings = Object.freeze({
      ...(policy.settings as Readonly<Record<string, unknown>>),
      ...(patch.settings as Readonly<Record<string, unknown>>),
    });
  }
  if ("rules" in policy && patch.rules !== undefined) {
    merged.rules = freezeRuleSettings({ ...policy.rules, ...patch.rules });
  }
  return Object.freeze(merged) as unknown as Readonly<ResolvedCheckPolicy>;
}
