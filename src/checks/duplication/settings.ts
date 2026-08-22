import { z } from "zod";
import type { ManagedSettingsDefinition } from "../../config/settings-definition.js";

export const duplicationSettingsSchema = z
  .object({
    minLines: z.number().int().positive(),
    minTokens: z.number().int().positive(),
    mode: z.enum(["strict", "mild", "weak"]),
  })
  .strict();

export type DuplicationSettings = z.infer<typeof duplicationSettingsSchema>;

export const DEFAULT_DUPLICATION_SETTINGS: Readonly<DuplicationSettings> =
  Object.freeze({
    minLines: 5,
    minTokens: 50,
    mode: "mild",
  });

export function jscpdOptions(
  settings: Readonly<DuplicationSettings>,
): DuplicationSettings {
  return {
    minLines: settings.minLines,
    minTokens: settings.minTokens,
    mode: settings.mode,
  };
}

export const DUPLICATION_SETTINGS_DEFINITION: ManagedSettingsDefinition<DuplicationSettings> =
  Object.freeze({
    scope: "workspace",
    schema: duplicationSettingsSchema,
    defaults: DEFAULT_DUPLICATION_SETTINGS,
    describe: Object.freeze({
      minLines: "Minimum duplicate fragment length in source lines.",
      minTokens: "Minimum duplicate fragment length in parsed tokens.",
      mode: "jscpd matching strictness.",
    }),
    toEngineOptions: jscpdOptions,
  });
