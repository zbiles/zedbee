import {
  CHECK_IDS,
  type CheckId,
  type CheckPolicyInput,
  type CheckSeverity,
  type CheckTiming,
  type ConfigFile,
  type ProfileId,
  type ResolvedCheckPolicies,
  type ResolvedCheckPolicy,
  type ResolvedCheckPolicyPatch,
  type ResolvedConfig,
  type ResolvedPolicyOverride,
} from "./schema.js";
import { normalizeAgentGuidance } from "../reporting/agent-guidance.js";
import {
  DEFAULT_FORMATTING_SETTINGS,
  formattingSettingsSchema,
  type FormattingSettings,
} from "../checks/prettier/settings.js";
import {
  DEFAULT_DUPLICATION_SETTINGS,
  duplicationSettingsSchema,
  type DuplicationSettings,
} from "../checks/duplication/settings.js";
import {
  freezeRuleSettings,
  validateManagedRuleConfiguration,
  type RuleCheckId,
} from "../checks/eslint/rule-settings.js";
import type {
  EslintRuleConfiguration,
  ResolvedConfigurationOrigins,
  SettingOrigin,
} from "./settings-definition.js";
import { isConfigurableRuleCheckId } from "./settings-registry.js";

const FAST_CHECKS = new Set<CheckId>([
  "formatting",
  "lint",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "structuralSecurity",
  "reactCorrectness",
  "reactAccessibility",
]);
const RECOMMENDED_CHECKS = new Set<CheckId>([
  ...FAST_CHECKS,
  "types",
  "secrets",
]);
const THOROUGH_CHECKS = new Set<CheckId>(CHECK_IDS);

const PROFILE_ENABLED_CHECKS: Readonly<
  Record<ProfileId, ReadonlySet<CheckId>>
> = {
  fast: FAST_CHECKS,
  recommended: RECOMMENDED_CHECKS,
  thorough: THOROUGH_CHECKS,
};

type MutableCheckPolicies = {
  -readonly [K in keyof ResolvedCheckPolicies]: ResolvedCheckPolicies[K];
};

function baseChecks(profile: ProfileId): MutableCheckPolicies {
  const enabled = PROFILE_ENABLED_CHECKS[profile];
  const common = (checkId: CheckId) => ({
    severity: enabled.has(checkId) ? ("error" as const) : ("off" as const),
    when: "relevant" as const,
  });
  return {
    formatting: {
      ...common("formatting"),
      settings: DEFAULT_FORMATTING_SETTINGS,
    },
    lint: {
      ...common("lint"),
      rules: Object.freeze({}),
      typeInformation: "required",
    },
    types: common("types"),
    cyclomaticComplexity: {
      ...common("cyclomaticComplexity"),
      max: 20,
      blockWorsening: true,
    },
    readabilityComplexity: {
      ...common("readabilityComplexity"),
      max: 15,
      blockWorsening: true,
    },
    structuralSecurity: common("structuralSecurity"),
    secrets: common("secrets"),
    duplication: {
      ...common("duplication"),
      threshold: 5,
      settings: DEFAULT_DUPLICATION_SETTINGS,
    },
    dependencyArchitecture: common("dependencyArchitecture"),
    deadCode: common("deadCode"),
    reactCorrectness: {
      ...common("reactCorrectness"),
      rules: Object.freeze({}),
    },
    reactAccessibility: {
      ...common("reactAccessibility"),
      rules: Object.freeze({}),
    },
    vulnerabilities: {
      ...common("vulnerabilities"),
      onUnavailable: "block",
    },
  };
}

function isRuleCheckId(checkId: CheckId): checkId is RuleCheckId {
  return isConfigurableRuleCheckId(checkId);
}

function policyPatch(
  checkId: CheckId,
  input: CheckPolicyInput,
): ResolvedCheckPolicyPatch {
  if (typeof input === "string") {
    return { severity: input };
  }

  const objectInput = input as ResolvedCheckPolicyPatch;
  const patch: {
    severity?: CheckSeverity;
    when?: CheckTiming;
    max?: number;
    threshold?: number;
    settings?: ResolvedCheckPolicyPatch["settings"];
    rules?: ResolvedCheckPolicyPatch["rules"];
    blockWorsening?: boolean;
    onUnavailable?: "block" | "warn";
    typeInformation?: "required" | "when-available";
  } = {};
  if (objectInput.severity !== undefined) patch.severity = objectInput.severity;
  if (objectInput.when !== undefined) patch.when = objectInput.when;
  if (objectInput.max !== undefined) patch.max = objectInput.max;
  if (objectInput.threshold !== undefined)
    patch.threshold = objectInput.threshold;
  if (objectInput.settings !== undefined) {
    patch.settings = Object.freeze({ ...objectInput.settings });
  }
  if (objectInput.rules !== undefined) {
    if (!isRuleCheckId(checkId)) {
      throw new TypeError(`${checkId} does not support managed rule overrides`);
    }
    patch.rules = validateManagedRuleConfiguration(checkId, objectInput.rules);
  }
  if (objectInput.blockWorsening !== undefined) {
    patch.blockWorsening = objectInput.blockWorsening;
  }
  if (objectInput.onUnavailable !== undefined) {
    patch.onUnavailable = objectInput.onUnavailable;
  }
  if (objectInput.typeInformation !== undefined) {
    patch.typeInformation = objectInput.typeInformation;
  }
  return Object.freeze(patch) as ResolvedCheckPolicyPatch;
}

function freezeRules(
  rules: Readonly<Record<string, EslintRuleConfiguration>>,
): Readonly<Record<string, EslintRuleConfiguration>> {
  return freezeRuleSettings(rules);
}

function freezeFormattingSettings(
  settings: Readonly<FormattingSettings>,
): Readonly<FormattingSettings> {
  return Object.freeze(formattingSettingsSchema.parse(settings));
}

function freezeDuplicationSettings(
  settings: Readonly<DuplicationSettings>,
): Readonly<DuplicationSettings> {
  return Object.freeze(duplicationSettingsSchema.parse(settings));
}

function resolvePolicy(
  checkId: CheckId,
  base: ResolvedCheckPolicy,
  override: CheckPolicyInput | undefined,
): ResolvedCheckPolicy {
  const patch = override === undefined ? {} : policyPatch(checkId, override);
  switch (checkId) {
    case "formatting": {
      const basePolicy = base as ResolvedCheckPolicies["formatting"];
      const settingsPatch = patch.settings as
        Partial<FormattingSettings> | undefined;
      return Object.freeze({
        ...basePolicy,
        ...patch,
        settings: freezeFormattingSettings({
          ...basePolicy.settings,
          ...settingsPatch,
        }),
      });
    }
    case "duplication": {
      const basePolicy = base as ResolvedCheckPolicies["duplication"];
      const settingsPatch = patch.settings as
        Partial<DuplicationSettings> | undefined;
      return Object.freeze({
        ...basePolicy,
        ...patch,
        settings: freezeDuplicationSettings({
          ...basePolicy.settings,
          ...settingsPatch,
        }),
      });
    }
    case "lint":
    case "reactCorrectness":
    case "reactAccessibility": {
      const basePolicy = base as ResolvedCheckPolicies[typeof checkId];
      return Object.freeze({
        ...basePolicy,
        ...patch,
        rules: freezeRules({ ...basePolicy.rules, ...patch.rules }),
      });
    }
    default:
      return Object.freeze({ ...base, ...patch });
  }
}

function policyInput(
  checks: NonNullable<ConfigFile["checks"]>,
  checkId: CheckId,
): CheckPolicyInput | undefined {
  return checks[checkId] as CheckPolicyInput | undefined;
}

function emptyOrigins(): Record<CheckId, Record<string, SettingOrigin>> {
  return Object.fromEntries(
    CHECK_IDS.map((checkId) => [checkId, {}]),
  ) as Record<CheckId, Record<string, SettingOrigin>>;
}

function freezeOrigins(
  origins: Record<CheckId, Record<string, SettingOrigin>>,
): ResolvedConfigurationOrigins {
  return Object.freeze(
    Object.fromEntries(
      CHECK_IDS.map((checkId) => [
        checkId,
        Object.freeze({ ...origins[checkId] }),
      ]),
    ),
  ) as ResolvedConfigurationOrigins;
}

function recordOrigin(
  origins: Record<CheckId, Record<string, SettingOrigin>>,
  checkId: CheckId,
  key: string,
  origin: SettingOrigin,
): void {
  origins[checkId][key] = origin;
}

function originForRepository(configPath: string | undefined): SettingOrigin {
  return Object.freeze(
    configPath === undefined
      ? { kind: "repository" as const }
      : { kind: "repository" as const, configPath },
  );
}

function defaultPolicyKeys(policy: ResolvedCheckPolicy): readonly string[] {
  const keys = ["severity", "when"];
  if ("max" in policy) keys.push("max");
  if ("blockWorsening" in policy) keys.push("blockWorsening");
  if ("threshold" in policy) keys.push("threshold");
  if ("onUnavailable" in policy) keys.push("onUnavailable");
  if ("settings" in policy) {
    keys.push(...Object.keys(policy.settings).map((key) => `settings.${key}`));
  }
  if ("rules" in policy) {
    keys.push(...Object.keys(policy.rules).map((key) => `rules.${key}`));
  }
  return keys;
}

function recordPatchOrigins(
  origins: Record<CheckId, Record<string, SettingOrigin>>,
  checkId: CheckId,
  patch: ResolvedCheckPolicyPatch | undefined,
  origin: SettingOrigin,
): void {
  if (patch === undefined) return;
  if (patch.severity !== undefined) {
    recordOrigin(origins, checkId, "severity", origin);
  }
  if (patch.when !== undefined) recordOrigin(origins, checkId, "when", origin);
  if (patch.max !== undefined) recordOrigin(origins, checkId, "max", origin);
  if (patch.blockWorsening !== undefined) {
    recordOrigin(origins, checkId, "blockWorsening", origin);
  }
  if (patch.threshold !== undefined) {
    recordOrigin(origins, checkId, "threshold", origin);
  }
  if (patch.onUnavailable !== undefined) {
    recordOrigin(origins, checkId, "onUnavailable", origin);
  }
  if (patch.typeInformation !== undefined) {
    recordOrigin(origins, checkId, "typeInformation", origin);
  }
  if (patch.settings !== undefined) {
    for (const key of Object.keys(patch.settings)) {
      recordOrigin(origins, checkId, `settings.${key}`, origin);
    }
  }
  if (patch.rules !== undefined) {
    for (const key of Object.keys(patch.rules)) {
      recordOrigin(origins, checkId, `rules.${key}`, origin);
    }
  }
}

function resolveOverrides(
  file: ConfigFile | undefined,
): readonly ResolvedPolicyOverride[] {
  return (file?.overrides ?? []).map((override, index) => {
    const checks: Partial<Record<CheckId, ResolvedCheckPolicyPatch>> = {};
    const configurationOrigins = emptyOrigins();
    for (const checkId of CHECK_IDS) {
      const input = policyInput(override.checks, checkId);
      if (input !== undefined) {
        checks[checkId] = policyPatch(checkId, input);
        recordPatchOrigins(
          configurationOrigins,
          checkId,
          checks[checkId],
          Object.freeze({
            kind: "override",
            index,
            files: Object.freeze([...override.files]),
          }),
        );
      }
    }
    return {
      files: Object.freeze([...override.files]),
      checks: Object.freeze(checks),
      configurationOrigins: freezeOrigins(configurationOrigins),
    };
  });
}

export function resolveConfig(
  file: ConfigFile | undefined,
  configPath?: string,
): ResolvedConfig {
  const profile = file?.profile ?? "recommended";
  const checks = baseChecks(profile);
  const mutableOrigins = emptyOrigins();
  const profileOrigin: SettingOrigin = Object.freeze({
    kind: "profile",
    profile,
  });
  for (const checkId of CHECK_IDS) {
    for (const key of defaultPolicyKeys(checks[checkId])) {
      recordOrigin(mutableOrigins, checkId, key, profileOrigin);
    }
  }

  const repositoryOrigin = originForRepository(configPath);
  const mutableChecks = checks as unknown as Record<
    CheckId,
    ResolvedCheckPolicy
  >;
  for (const checkId of CHECK_IDS) {
    const input =
      file?.checks === undefined
        ? undefined
        : policyInput(file.checks, checkId);
    mutableChecks[checkId] = resolvePolicy(
      checkId,
      mutableChecks[checkId],
      input,
    );
    recordPatchOrigins(
      mutableOrigins,
      checkId,
      input === undefined ? undefined : policyPatch(checkId, input),
      repositoryOrigin,
    );
  }

  const resolved: ResolvedConfig = {
    schemaVersion: 1,
    profile,
    checks: Object.freeze(checks),
    overrides: resolveOverrides(file),
    reporting: Object.freeze({
      sourceExcerpts: file?.reporting?.sourceExcerpts ?? "interactive",
      terminalFindingLimit: file?.reporting?.terminalFindingLimit ?? 25,
      temporaryReportMaxAge: file?.reporting?.temporaryReportMaxAge ?? "24h",
      agentGuidance: normalizeAgentGuidance(file?.reporting?.agentGuidance),
    }),
    resources: Object.freeze({
      ...(file?.resources?.git?.softTimeout === undefined
        ? {}
        : { gitSoftTimeout: file.resources.git.softTimeout }),
      ...(file?.resources?.git?.hardTimeout === undefined
        ? {}
        : { gitHardTimeout: file.resources.git.hardTimeout }),
      ...(file?.resources?.git?.outputLimitBytes === undefined
        ? {}
        : { gitOutputLimitBytes: file.resources.git.outputLimitBytes }),
    }),
    configurationOrigins: freezeOrigins(mutableOrigins),
    failOnIncomplete: file?.failOnIncomplete ?? true,
  };

  return configPath === undefined ? resolved : { ...resolved, configPath };
}
