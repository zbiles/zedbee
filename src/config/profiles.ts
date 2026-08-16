import {
  CHECK_IDS,
  type CheckId,
  type CheckPolicyInput,
  type ConfigFile,
  type ProfileId,
  type ResolvedCheckPolicy,
  type ResolvedCheckPolicyPatch,
  type ResolvedConfig,
  type ResolvedPolicyOverride,
} from "./schema.js";

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

function baseChecks(profile: ProfileId): Record<CheckId, ResolvedCheckPolicy> {
  const enabled = PROFILE_ENABLED_CHECKS[profile];
  return Object.fromEntries(
    CHECK_IDS.map((checkId) => {
      const common = {
        severity: enabled.has(checkId) ? ("error" as const) : ("off" as const),
        when: "relevant" as const,
      };
      if (checkId === "cyclomaticComplexity") {
        return [checkId, { ...common, max: 20, blockWorsening: true }];
      }
      if (checkId === "readabilityComplexity") {
        return [checkId, { ...common, max: 15, blockWorsening: true }];
      }
      if (checkId === "duplication") {
        return [checkId, { ...common, threshold: 5 }];
      }
      if (checkId === "vulnerabilities") {
        return [checkId, { ...common, network: "online" as const }];
      }
      return [checkId, common];
    }),
  ) as Record<CheckId, ResolvedCheckPolicy>;
}

function policyPatch(input: CheckPolicyInput): ResolvedCheckPolicyPatch {
  if (typeof input === "string") {
    return { severity: input };
  }

  const objectInput = input as ResolvedCheckPolicyPatch;
  const patch: Partial<ResolvedCheckPolicy> = {};
  if (objectInput.severity !== undefined) patch.severity = objectInput.severity;
  if (objectInput.when !== undefined) patch.when = objectInput.when;
  if (objectInput.max !== undefined) patch.max = objectInput.max;
  if (objectInput.threshold !== undefined)
    patch.threshold = objectInput.threshold;
  if (objectInput.blockWorsening !== undefined) {
    patch.blockWorsening = objectInput.blockWorsening;
  }
  if (objectInput.network !== undefined) patch.network = objectInput.network;
  return patch;
}

function resolvePolicy(
  base: ResolvedCheckPolicy,
  override: CheckPolicyInput | undefined,
): ResolvedCheckPolicy {
  return override === undefined
    ? { ...base }
    : { ...base, ...policyPatch(override) };
}

function policyInput(
  checks: NonNullable<ConfigFile["checks"]>,
  checkId: CheckId,
): CheckPolicyInput | undefined {
  return checks[checkId] as CheckPolicyInput | undefined;
}

function resolveOverrides(
  file: ConfigFile | undefined,
): readonly ResolvedPolicyOverride[] {
  return (file?.overrides ?? []).map((override) => {
    const checks: Partial<Record<CheckId, ResolvedCheckPolicyPatch>> = {};
    for (const checkId of CHECK_IDS) {
      const input = policyInput(override.checks, checkId);
      if (input !== undefined) {
        checks[checkId] = policyPatch(input);
      }
    }
    return { files: [...override.files], checks };
  });
}

export function resolveConfig(
  file: ConfigFile | undefined,
  configPath?: string,
): ResolvedConfig {
  const profile = file?.profile ?? "recommended";
  const checks = baseChecks(profile);
  for (const checkId of CHECK_IDS) {
    checks[checkId] = resolvePolicy(
      checks[checkId],
      file?.checks === undefined
        ? undefined
        : policyInput(file.checks, checkId),
    );
  }

  const resolved: ResolvedConfig = {
    schemaVersion: 1,
    profile,
    checks,
    overrides: resolveOverrides(file),
    failOnIncomplete: file?.failOnIncomplete ?? true,
  };

  return configPath === undefined ? resolved : { ...resolved, configPath };
}
