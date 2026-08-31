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
}

const MANAGED_SETTINGS_DEFINITIONS: ManagedSettingsDefinitions = Object.freeze({
  formatting: FORMATTING_SETTINGS_DEFINITION,
  duplication: DUPLICATION_SETTINGS_DEFINITION,
});

export function managedSettingDefinition(
  checkId: CheckId,
): ManagedSettingsDefinition<object> | undefined {
  return MANAGED_SETTINGS_DEFINITIONS[
    checkId as keyof ManagedSettingsDefinitions
  ] as ManagedSettingsDefinition<object> | undefined;
}

const MANAGED_POLICY_SCALAR_KEYS = Object.freeze({
  formatting: [],
  lint: [],
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

const UNSAFE_CONFIGURATION_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function unsupportedConfiguration(): TypeError {
  return new TypeError(
    "Managed configuration must contain only JSON-compatible data.",
  );
}

function immutableJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (Number.isFinite(value)) return value;
      throw unsupportedConfiguration();
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      throw unsupportedConfiguration();
    case "object":
      break;
  }

  if (ancestors.has(value)) throw unsupportedConfiguration();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw unsupportedConfiguration();
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        keys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" &&
              (!/^(?:0|[1-9][0-9]*)$/u.test(key) ||
                Number(key) >= value.length)),
        )
      ) {
        throw unsupportedConfiguration();
      }
      return Object.freeze(
        Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (
            descriptor === undefined ||
            descriptor.enumerable !== true ||
            !("value" in descriptor)
          ) {
            throw unsupportedConfiguration();
          }
          return immutableJsonValue(descriptor.value, ancestors);
        }),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw unsupportedConfiguration();
    }
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(value).sort((left, right) =>
      compareCodeUnits(String(left), String(right)),
    )) {
      if (typeof key !== "string" || UNSAFE_CONFIGURATION_KEYS.has(key)) {
        throw unsupportedConfiguration();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw unsupportedConfiguration();
      }
      entries.push([key, immutableJsonValue(descriptor.value, ancestors)]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
}

export function immutableConfigurationSnapshot<T>(value: T): Readonly<T> {
  return immutableJsonValue(value, new Set()) as Readonly<T>;
}

const POLICY_KEYS = Object.freeze({
  formatting: ["severity", "settings", "when"],
  lint: ["rules", "severity", "typeInformation", "when"],
  types: ["severity", "when"],
  cyclomaticComplexity: ["blockWorsening", "max", "severity", "when"],
  readabilityComplexity: ["blockWorsening", "max", "severity", "when"],
  structuralSecurity: ["severity", "when"],
  secrets: ["severity", "when"],
  duplication: ["settings", "severity", "threshold", "when"],
  dependencyArchitecture: ["severity", "when"],
  deadCode: ["severity", "when"],
  reactCorrectness: ["rules", "severity", "when"],
  reactAccessibility: ["rules", "severity", "when"],
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
