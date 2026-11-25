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
    ([key, origin]) => key.startsWith("settings.") && origin.kind !== "profile",
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
  assertProjectEslintConfiguration(config, inspection);
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
    const includes = override.files.map((pattern) =>
      picomatch(pattern, { dot: true }),
    );
    const excludes = (override.excludeFiles ?? []).map((pattern) =>
      picomatch(pattern, { dot: true }),
    );
    const matches = candidates.some(
      (candidate) =>
        includes.some((match) => match(candidate)) &&
        !excludes.some((match) => match(candidate)),
    );
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

/** Reject inert managed configuration that project ESLint would otherwise ignore. */
function assertProjectOwnedPolicy(
  config: ResolvedConfig,
  lint: ResolvedCheckPolicies["lint"],
  patches: readonly ResolvedCheckPolicyPatch[],
  reactPatches: readonly ResolvedCheckPolicyPatch[],
): void {
  if (lint.engine !== "project") return;
  if (
    lint.severity === "off" ||
    patches.some((patch) => patch.severity === "off")
  ) {
    throw new TypeError(
      'Project ESLint cannot be selected while lint is off. Enable lint explicitly or select engine "managed".',
    );
  }
  const origin = config.configurationOrigins;
  const explicit = (checkId: CheckId, predicate: (key: string) => boolean) =>
    Object.entries(origin[checkId]).some(
      ([key, value]) => value.kind !== "profile" && predicate(key),
    );
  if (
    explicit(
      "lint",
      (key) => key.startsWith("rules.") || key === "typeInformation",
    ) ||
    Object.keys(config.checks.lint.rules).length > 0 ||
    patches.some(
      (patch) =>
        patch.rules !== undefined || patch.typeInformation !== undefined,
    ) ||
    ["reactCorrectness", "reactAccessibility"].some((checkId) =>
      explicit(
        checkId as CheckId,
        (key) =>
          key === "severity" ||
          key.startsWith("rules.") ||
          key.startsWith("settings."),
      ),
    ) ||
    reactPatches.some(
      (patch) =>
        patch.severity !== undefined ||
        patch.rules !== undefined ||
        patch.settings !== undefined,
    )
  ) {
    throw new TypeError(
      'Project ESLint replaces managed lint, React, and accessibility rules. Remove explicit managed rule/settings overrides and React/accessibility severity overrides in that workspace, or select engine "managed".',
    );
  }
}

export function resolveWorkspaceLintPolicy(
  config: ResolvedConfig,
  workspace: WorkspaceInspection,
): ResolvedCheckPolicies["lint"] {
  let policy = config.checks.lint;
  for (const override of config.overrides) {
    if (override.checks.lint === undefined) continue;
    if (
      override.files.some((pattern) =>
        picomatch(pattern, { dot: true })(workspace.manifestPath),
      ) &&
      !(override.excludeFiles ?? []).some((pattern) =>
        picomatch(pattern, { dot: true })(workspace.manifestPath),
      )
    ) {
      policy = mergePolicyPatch<"lint">(policy, override.checks.lint);
    }
  }
  return policy;
}

/** Conservative glob overlap: an unknown wildcard may reach any workspace below its literal prefix. */
function scopeMayReachWorkspace(
  patterns: readonly string[],
  workspace: WorkspaceInspection,
  inspection: RepositoryInspection,
): boolean {
  return patterns.some((pattern) => {
    const prefix = pattern.split(/[?*\[\]{}!()]/u)[0]!.replace(/\/$/u, "");
    const root = workspace.relativeRoot === "." ? "" : workspace.relativeRoot;
    const ownsPrefix = inspection.workspaces
      .filter(
        ({ relativeRoot }) =>
          relativeRoot !== "." &&
          (prefix === relativeRoot || prefix.startsWith(`${relativeRoot}/`)),
      )
      .sort(
        (left, right) => right.relativeRoot.length - left.relativeRoot.length,
      )[0];
    if (
      ownsPrefix !== undefined &&
      root !== ownsPrefix.relativeRoot &&
      !root.startsWith(`${ownsPrefix.relativeRoot}/`)
    )
      return false;
    return (
      root === "" ||
      prefix === "" ||
      root === prefix ||
      root.startsWith(`${prefix}/`) ||
      prefix.startsWith(`${root}/`)
    );
  });
}

/** Run after workspace inspection; this validates ownership without executing project code. */
export function assertProjectEslintConfiguration(
  config: ResolvedConfig,
  inspection?: RepositoryInspection,
): void {
  if (inspection === undefined) {
    if (config.checks.lint.engine === "project")
      assertProjectOwnedPolicy(config, config.checks.lint, [], []);
    return;
  }
  const roots = new Set(
    inspection.workspaces.map(({ relativeRoot }) => relativeRoot),
  );
  for (const override of config.overrides) {
    if (override.checks.lint?.engine === undefined) continue;
    if (
      override.excludeFiles !== undefined ||
      override.files.some(
        (pattern) =>
          pattern !== "**" &&
          (!pattern.endsWith("/**") || !roots.has(pattern.slice(0, -3))),
      )
    ) {
      throw new TypeError(
        "ESLint engine overrides must select an entire inspected workspace using its literal path followed by /**.",
      );
    }
  }
  for (const workspace of inspection.workspaces) {
    const lint = resolveWorkspaceLintPolicy(config, workspace);
    if (lint.engine !== "project") continue;
    const scopes = config.overrides.filter(
      (override) =>
        scopeMayReachWorkspace(override.files, workspace, inspection) &&
        !(override.excludeFiles ?? []).some((pattern) => {
          if (pattern === "**" || pattern === "**/*") return true;
          const base = pattern.endsWith("/**")
            ? pattern.slice(0, -3)
            : undefined;
          return (
            base !== undefined &&
            !/[?*\[\]{}!()]/u.test(base) &&
            (workspace.relativeRoot === base ||
              workspace.relativeRoot.startsWith(`${base}/`))
          );
        }),
    );
    assertProjectOwnedPolicy(
      config,
      lint,
      scopes.flatMap(({ checks }) =>
        checks.lint === undefined ? [] : [checks.lint],
      ),
      scopes.flatMap(({ checks }) =>
        [checks.reactCorrectness, checks.reactAccessibility].filter(
          (patch) => patch !== undefined,
        ),
      ),
    );
    if (
      config.pathExclusions.some(
        (exclusion) =>
          exclusion.checks.some(
            (id) => id === "reactCorrectness" || id === "reactAccessibility",
          ) &&
          (exclusion.syntax === "gitignore" ||
            scopeMayReachWorkspace(exclusion.files, workspace, inspection)),
      )
    ) {
      throw new TypeError(
        "Project ESLint owns React and accessibility coverage; remove managed React/accessibility path exclusions from that workspace.",
      );
    }
  }
}
