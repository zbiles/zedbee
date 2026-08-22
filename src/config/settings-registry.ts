import type { CheckId } from "./schema.js";
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
