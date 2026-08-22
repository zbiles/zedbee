import type { CheckId } from "../config/schema.js";
import type { ExecutionClass } from "./adapter.js";

export interface CheckApplicabilityDescription {
  readonly applicable: boolean;
  readonly targets: readonly string[];
  readonly executionClass: ExecutionClass;
  readonly reason?: string;
}

export interface EffectiveSettingDescription {
  readonly value: unknown;
  readonly source: "profile" | "repository";
  readonly customized: boolean;
}

export interface CheckConfigurationDescription {
  readonly customized: boolean;
  readonly values: Readonly<Record<string, EffectiveSettingDescription>>;
  readonly overrides: readonly Readonly<{
    readonly files: readonly string[];
    readonly values: Readonly<Record<string, unknown>>;
  }>[];
}

export interface CheckDescription {
  readonly id: CheckId;
  readonly description: string;
  readonly severity: string;
  readonly timing: string;
  readonly applicability: "applicable" | "not-applicable";
  readonly targets: readonly string[];
  readonly executionClass: ExecutionClass;
  readonly network: "none" | "online-package-metadata-only";
  readonly engine: {
    readonly name: string;
    readonly version: string;
    readonly license: string;
  };
  readonly limitation: string;
  readonly configuration: CheckConfigurationDescription;
  readonly reason?: string;
}
