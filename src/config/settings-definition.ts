import type { z } from "zod";
import type { CheckId } from "./schema.js";

export type SettingScope = "repository" | "workspace" | "file";
export type EslintRuleSeverity = "off" | "warn" | "error" | 0 | 1 | 2;
export type EslintRuleConfiguration =
  EslintRuleSeverity | readonly [EslintRuleSeverity, ...unknown[]];

export type SettingOrigin =
  | Readonly<{ kind: "profile"; profile: string }>
  | Readonly<{ kind: "repository"; configPath?: string }>
  | Readonly<{ kind: "override"; index: number; files: readonly string[] }>;

export type ResolvedConfigurationOrigins = Readonly<
  Record<CheckId, Readonly<Record<string, SettingOrigin>>>
>;

export interface ManagedSettingsDefinition<TSettings extends object> {
  readonly scope: SettingScope;
  readonly schema: z.ZodType<TSettings>;
  readonly defaults: Readonly<TSettings>;
  readonly describe: Readonly<Record<keyof TSettings, string>>;
  readonly toEngineOptions: (settings: Readonly<TSettings>) => unknown;
}
