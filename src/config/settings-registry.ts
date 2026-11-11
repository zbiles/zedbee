import {
  ACCESSIBILITY_SETTINGS_DEFINITION,
  type AccessibilitySettings,
} from "../checks/react/accessibility-settings.js";
import { compareCodeUnits } from "../core/compare.js";
import type {
  CheckId,
  ResolvedCheckPolicy,
  ResolvedCheckPolicyPatch,
} from "./schema.js";
import type { ManagedSettingsDefinition } from "./settings-definition.js";
import {
  FORMATTING_SETTINGS_DEFINITION,
  type FormattingSettings,
} from "../checks/prettier/settings.js";
import {
  DUPLICATION_SETTINGS_DEFINITION,
  type DuplicationSettings,
} from "../checks/duplication/settings.js";

export const CONFIGURABLE_CHECK_IDS = [
  "formatting",
  "lint",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "duplication",
  "reactCorrectness",
  "reactAccessibility",
] as const satisfies readonly CheckId[];

export type ConfigurableCheckId = (typeof CONFIGURABLE_CHECK_IDS)[number];
export const CONFIGURABLE_RULE_CHECK_IDS = [
  "lint",
  "reactCorrectness",
  "reactAccessibility",
] as const satisfies readonly ConfigurableCheckId[];
export type ConfigurableRuleCheckId =
  (typeof CONFIGURABLE_RULE_CHECK_IDS)[number];

export interface ManagedSettingsDefinitions {
  readonly formatting: ManagedSettingsDefinition<FormattingSettings>;
  readonly duplication: ManagedSettingsDefinition<DuplicationSettings>;
  readonly reactAccessibility: ManagedSettingsDefinition<AccessibilitySettings>;
}

const MANAGED_SETTINGS_DEFINITIONS: ManagedSettingsDefinitions = Object.freeze({
  formatting: FORMATTING_SETTINGS_DEFINITION,
  duplication: DUPLICATION_SETTINGS_DEFINITION,
  reactAccessibility: ACCESSIBILITY_SETTINGS_DEFINITION,
});

export function managedSettingDefinition(
  checkId: CheckId,
): ManagedSettingsDefinition<object> | undefined {
  return MANAGED_SETTINGS_DEFINITIONS[
    checkId as keyof ManagedSettingsDefinitions
  ] as ManagedSettingsDefinition<object> | undefined;
}

const MANAGED_POLICY_SCALAR_KEYS = Object.freeze({
  formatting: ["engine"],
  lint: ["engine"],
  types: [],
  cyclomaticComplexity: ["blockWorsening", "max"],
  readabilityComplexity: ["blockWorsening", "max"],
  structuralSecurity: [],
  secrets: [],
  duplication: ["threshold"],
  dependencyArchitecture: [],
  deadCode: [],
  reactCorrectness: [],
  reactAccessibility: [],
  vulnerabilities: ["onUnavailable"],
} as const satisfies Readonly<Record<CheckId, readonly string[]>>);

export function managedPolicyScalarKeys(checkId: CheckId): readonly string[] {
  return MANAGED_POLICY_SCALAR_KEYS[checkId];
}

export function managedSettingKeys(checkId: CheckId): readonly string[] {
  const definition = managedSettingDefinition(checkId);
  if (definition === undefined) return Object.freeze([]);
  return Object.freeze(Object.keys(definition.describe).sort(compareCodeUnits));
}

export function isConfigurableRuleCheckId(
  checkId: CheckId,
): checkId is ConfigurableRuleCheckId {
  return CONFIGURABLE_RULE_CHECK_IDS.includes(
    checkId as ConfigurableRuleCheckId,
  );
}

export { immutableConfigurationSnapshot } from "./immutable-configuration.js";
import { immutableConfigurationSnapshot } from "./immutable-configuration.js";

function unsupportedConfiguration(): TypeError {
  return new TypeError(
    "Managed configuration must contain only JSON-compatible data.",
  );
}

const POLICY_KEYS = Object.freeze({
  formatting: ["engine", "severity", "settings", "when"],
  lint: ["engine", "rules", "severity", "typeInformation", "when"],
  types: ["severity", "when"],
  cyclomaticComplexity: ["blockWorsening", "max", "severity", "when"],
  readabilityComplexity: ["blockWorsening", "max", "severity", "when"],
  structuralSecurity: ["severity", "when"],
  secrets: ["severity", "when"],
  duplication: ["settings", "severity", "threshold", "when"],
  dependencyArchitecture: ["severity", "when"],
  deadCode: ["severity", "when"],
  reactCorrectness: ["rules", "severity", "when"],
  reactAccessibility: ["rules", "settings", "severity", "when"],
  vulnerabilities: ["onUnavailable", "severity", "when"],
} as const satisfies Readonly<Record<CheckId, readonly string[]>>);

export function snapshotManagedPolicy<
  T extends ResolvedCheckPolicy | ResolvedCheckPolicyPatch,
>(checkId: CheckId, policy: Readonly<T>): Readonly<T> {
  const allowed = new Set<string>(POLICY_KEYS[checkId]);
  for (const key of Reflect.ownKeys(policy)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw unsupportedConfiguration();
    }
  }
  if ("settings" in policy && managedSettingDefinition(checkId) === undefined) {
    throw unsupportedConfiguration();
  }
  if ("rules" in policy && !isConfigurableRuleCheckId(checkId)) {
    throw unsupportedConfiguration();
  }
  return immutableConfigurationSnapshot(policy) as Readonly<T>;
}
