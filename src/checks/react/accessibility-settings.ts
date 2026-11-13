import { z } from "zod";
import type { ManagedSettingsDefinition } from "../../config/settings-definition.js";
import { immutableConfigurationSnapshot } from "../../config/immutable-configuration.js";

const name = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}\p{Cf}\s]+$/u);
const key = name.refine(
  (value) => !["__proto__", "prototype", "constructor"].includes(value),
  "Unsafe mapping key",
);

/** Inert jsx-a11y settings only: no plugin, parser, or executable configuration. */
export const accessibilitySettingsSchema = z
  .object({
    components: z
      .record(key, name)
      .refine(
        (value) =>
          !Object.keys(value).some((name) =>
            ["__proto__", "prototype", "constructor"].includes(name),
          ),
        "Unsafe mapping key",
      )
      .optional(),
    attributes: z.record(key, z.array(name)).optional(),
    polymorphicPropName: name.optional(),
    polymorphicAllowList: z.array(name).optional(),
  })
  .strict();

export type AccessibilitySettings = z.infer<typeof accessibilitySettingsSchema>;
export const DEFAULT_ACCESSIBILITY_SETTINGS: Readonly<AccessibilitySettings> =
  Object.freeze({});

export function validateAccessibilitySettings(
  input: unknown,
): Readonly<AccessibilitySettings> {
  return immutableConfigurationSnapshot(
    accessibilitySettingsSchema.parse(immutableConfigurationSnapshot(input)),
  );
}

export const ACCESSIBILITY_SETTINGS_DEFINITION: ManagedSettingsDefinition<AccessibilitySettings> =
  Object.freeze({
    scope: "file",
    schema: accessibilitySettingsSchema,
    defaults: DEFAULT_ACCESSIBILITY_SETTINGS,
    describe: Object.freeze({
      components:
        "Map custom JSX components to their rendered DOM element names.",
      attributes:
        "Map DOM attribute names to the JSX property names checked by jsx-a11y.",
      polymorphicPropName:
        "Property that supplies a component's rendered element, such as as.",
      polymorphicAllowList:
        "Components allowed to supply a polymorphic rendered element.",
    }),
    toEngineOptions: validateAccessibilitySettings,
  });
