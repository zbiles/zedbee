import { createHash } from "node:crypto";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { CHECK_IDS, type CheckId } from "../config/schema.js";
import type { Environment, RepositoryInspection } from "../inspection/types.js";
import { RECOMMENDED_AGENT_GUIDANCE } from "../reporting/agent-guidance.js";
import { OSV_NETWORK_DISCLOSURE } from "./types.js";
import type {
  CreateInitProposalOptions,
  InitFileChange,
  InitFormattingChoice,
  InitFormattingImport,
  InitHookActivation,
  InitOsvUnavailable,
  InitProposal,
  ResolvedHookChoice,
} from "./types.js";

function formattingPolicyValue(
  choice: InitFormattingChoice,
  imported: InitFormattingImport | undefined,
  rootProject: boolean,
  severity: "off" | "error",
): unknown {
  if (choice === "off") return "off";
  if (choice === "project") {
    return {
      engine: rootProject ? "project" : "managed",
      severity: "error",
    };
  }
  if (choice === "copy") {
    return {
      severity: "error",
      settings: imported?.settings ?? {},
      generated: "prettier-copy",
    };
  }
  return severity;
}

function importedOverrideEntries(
  imported: InitFormattingImport | undefined,
): readonly Record<string, unknown>[] {
  if (imported === undefined) return [];
  // Prettier's excludeFiles has AND-within-OR semantics that Zedbee's
  // override globs cannot express; encoding it as a negated pattern would
  // widen the override to nearly every path. The importer reports it as a
  // copy limitation instead of silently changing its meaning.
  return imported.overrides.map((override) => ({
    files: [...override.files],
    checks: { formatting: { settings: override.settings } },
    generated: "prettier-copy",
  }));
}

function engineOverrideEntries(
  projectRoots: readonly string[],
): readonly Record<string, unknown>[] {
  return projectRoots.map((projectRoot) => ({
    files: [`${projectRoot}/**`],
    checks: { formatting: { engine: "project" } },
    generated: "prettier-engine",
  }));
}

/**
 * Ownership is decided exclusively by the authorship marker Zedbee wrote;
 * hand-authored entries that merely look similar are never touched.
 */
function isGeneratedOverrideEntry(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    ((entry as Record<string, unknown>).generated === "prettier-copy" ||
      (entry as Record<string, unknown>).generated === "prettier-engine")
  );
}

/** An existing explicit engine or off choice survives repeat init untouched. */
function existingFormattingChoice(before: string | null): InitFormattingChoice {
  if (before === null) return "managed";
  const errors: ParseError[] = [];
  const parsed: unknown = parse(before, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof parsed !== "object" || parsed === null) {
    return "managed";
  }
  const checks = (parsed as Record<string, unknown>).checks;
  if (typeof checks !== "object" || checks === null) return "managed";
  const formatting = (checks as Record<string, unknown>).formatting;
  if (formatting === "off") return "off";
  if (typeof formatting === "object" && formatting !== null) {
    const record = formatting as Record<string, unknown>;
    if (record.severity === "off") return "off";
    if (record.generated === "prettier-copy") return "copy";
    if (record.engine === "project") return "project";
  }
  const overrides = (parsed as Record<string, unknown>).overrides;
  if (
    Array.isArray(overrides) &&
    overrides.some((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as Record<string, unknown>;
      if (record.generated !== "prettier-engine") return false;
      const overrideChecks = record.checks;
      if (typeof overrideChecks !== "object" || overrideChecks === null) {
        return false;
      }
      const overrideFormatting = (
        overrideChecks as Record<string, unknown>
      ).formatting;
      return (
        typeof overrideFormatting === "object" &&
        overrideFormatting !== null &&
        (overrideFormatting as Record<string, unknown>).engine === "project"
      );
    })
  ) {
    return "project";
  }
  return "managed";
}


function defaultHookActivation(hook: ResolvedHookChoice): InitHookActivation {
  if (hook === "none") {
    return Object.freeze({
      status: "not-requested",
      message: "No pre-commit integration was requested.",
    });
  }
  if (hook === "lefthook") {
    return Object.freeze({
      status: "pending",
      message:
        "Lefthook configuration will invoke Zedbee, but the Git hook is not activated by initialization.",
      remediation:
        "After reviewing the project tooling, run lefthook install to activate the configured hook.",
    });
  }
  if (hook === "simple-git-hooks") {
    return Object.freeze({
      status: "pending",
      message:
        "simple-git-hooks configuration will invoke Zedbee, but the Git hook is not activated by initialization.",
      remediation:
        "After reviewing the project tooling, run npx --no-install simple-git-hooks to activate the configured hook.",
    });
  }
  return Object.freeze({
    status: "active",
    message: `The proposed ${hook} hook directly invokes Zedbee.`,
  });
}

const COMMON_CHECKS = new Set<CheckId>([
  "formatting",
  "lint",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "structuralSecurity",
  "secrets",
  "duplication",
  "deadCode",
]);
const PROFILE_CHECKS: Readonly<
  Record<CreateInitProposalOptions["profile"], ReadonlySet<CheckId>>
> = {
  fast: new Set([
    "formatting",
    "lint",
    "cyclomaticComplexity",
    "readabilityComplexity",
    "structuralSecurity",
    "reactCorrectness",
    "reactAccessibility",
  ]),
  recommended: new Set([
    "formatting",
    "lint",
    "types",
    "cyclomaticComplexity",
    "readabilityComplexity",
    "structuralSecurity",
    "secrets",
    "reactCorrectness",
    "reactAccessibility",
  ]),
  thorough: new Set(CHECK_IDS),
};
const ENVIRONMENT_ORDER: readonly Environment[] = [
  "javascript",
  "typescript",
  "react",
  "react-dom",
  "ink",
  "next",
  "remix",
  "vitest",
  "jest",
  "testing-library",
];

export function initContentHash(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

export function exactFilePreview(
  relativePath: string,
  before: string | null,
  after: string,
): string {
  const previous = before ?? "";
  const beforeLines = previous.length === 0 ? [] : previous.split("\n");
  const afterLines = after.length === 0 ? [] : after.split("\n");
  return [
    `--- ${relativePath}`,
    `+++ ${relativePath}`,
    "@@ exact before / after @@",
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n");
}

export function initFileChange(
  relativePath: string,
  before: string | null,
  after: string,
  mode: number,
  absolutePath?: string,
): InitFileChange {
  return Object.freeze({
    relativePath,
    ...(absolutePath === undefined ? {} : { absolutePath }),
    before,
    after,
    beforeHash: before === null ? null : initContentHash(before),
    afterHash: initContentHash(after),
    diff: exactFilePreview(relativePath, before, after),
    mode,
  });
}

interface FormattingConfigInput {
  readonly choice: InitFormattingChoice;
  readonly imported?: InitFormattingImport;
  /** Nested project roots that receive generated engine overrides. */
  readonly projectRoots?: readonly string[];
  /** Whether the repository root itself runs the project engine. */
  readonly rootProject?: boolean;
}

function configContents(
  profile: CreateInitProposalOptions["profile"],
  before: string | null,
  checks: readonly CheckId[] | undefined,
  vulnerabilitiesEnabled: boolean,
  osvUnavailable: InitOsvUnavailable,
  formatting: FormattingConfigInput | undefined,
): string {
  const configuredChecks =
    checks === undefined
      ? undefined
      : Object.fromEntries(
          CHECK_IDS.map((check) => [
            check,
            checks.includes(check)
              ? check === "vulnerabilities"
                ? { severity: "error", onUnavailable: osvUnavailable }
                : "error"
              : "off",
          ]),
        );
  const initialChecks =
    configuredChecks ??
    (vulnerabilitiesEnabled
      ? { vulnerabilities: { onUnavailable: osvUnavailable } }
      : undefined);
  if (before === null) {
    const checksValue =
      formatting === undefined
        ? initialChecks
        : {
            ...(initialChecks ?? {}),
            formatting: formattingPolicyValue(
              formatting.choice,
              formatting.imported,
              formatting.rootProject ?? true,
              "error",
            ),
          };
    const overrideValues = [
      ...importedOverrideEntries(formatting?.imported),
      ...engineOverrideEntries(
        formatting?.choice === "project"
          ? (formatting?.projectRoots ?? [])
          : [],
      ),
    ];
    return `${JSON.stringify(
      {
        $schema: "./node_modules/zedbee/schema/zedbee.schema.json",
        schemaVersion: 1,
        profile,
        ...(checksValue === undefined ? {} : { checks: checksValue }),
        ...(overrideValues.length === 0 ? {} : { overrides: overrideValues }),
        reporting: {
          agentGuidance: RECOMMENDED_AGENT_GUIDANCE,
        },
      },
      null,
      2,
    )}\n`;
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parse(before, errors, { allowTrailingComma: true });
  if (
    errors.length > 0 ||
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "Zedbee could not safely update the existing configuration.",
    );
  }
  const options = {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  };
  let updated = before;
  updated = applyEdits(
    updated,
    modify(
      updated,
      ["$schema"],
      "./node_modules/zedbee/schema/zedbee.schema.json",
      options,
    ),
  );
  updated = applyEdits(updated, modify(updated, ["schemaVersion"], 1, options));
  updated = applyEdits(updated, modify(updated, ["profile"], profile, options));
  if (configuredChecks !== undefined) {
    updated = applyEdits(
      updated,
      modify(updated, ["checks"], configuredChecks, options),
    );
  } else if (vulnerabilitiesEnabled) {
    const root = parsed as Record<string, unknown>;
    const checksValue = root.checks;
    const existingVulnerability =
      typeof checksValue === "object" &&
      checksValue !== null &&
      !Array.isArray(checksValue)
        ? (checksValue as Record<string, unknown>).vulnerabilities
        : undefined;
    if (existingVulnerability !== "off") {
      const value =
        existingVulnerability === "error" || existingVulnerability === "warn"
          ? {
              severity: existingVulnerability,
              onUnavailable: osvUnavailable,
            }
          : osvUnavailable;
      const path =
        typeof value === "string"
          ? ["checks", "vulnerabilities", "onUnavailable"]
          : ["checks", "vulnerabilities"];
      updated = applyEdits(updated, modify(updated, path, value, options));
    }
  }
  if (formatting !== undefined) {
    updated = applyFormattingChoice(
      updated,
      parsed,
      {
        choice: formatting.choice,
        ...(formatting.imported === undefined
          ? {}
          : { imported: formatting.imported }),
        projectRoots: formatting.projectRoots ?? [],
        rootProject: formatting.rootProject ?? true,
      },
      options,
    );
  }
  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

interface JsoncFormatOptions {
  readonly formattingOptions: {
    readonly insertSpaces: boolean;
    readonly tabSize: number;
    readonly eol: string;
  };
}

function applyFormattingChoice(
  updated: string,
  parsed: unknown,
  formatting: FormattingConfigInput & {
    readonly projectRoots: readonly string[];
    readonly rootProject: boolean;
  },
  options: JsoncFormatOptions,
): string {
  const root = parsed as Record<string, unknown>;
  const checksValue = root.checks;
  const checksObject =
    typeof checksValue === "object" &&
    checksValue !== null &&
    !Array.isArray(checksValue)
      ? (checksValue as Record<string, unknown>)
      : {};
  const existing = checksObject.formatting;
  const existingObject =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : undefined;
  const existingSeverity =
    existing === "off" || existing === "warn" || existing === "error"
      ? existing
      : existingObject?.severity === "off" ||
          existingObject?.severity === "warn" ||
          existingObject?.severity === "error"
        ? existingObject.severity
        : "error";
  // Ownership of the settings block is proven only by the authorship marker
  // a previous setup wrote; hand-written settings are never destroyed.
  const settingsOwnedBySetup =
    existingObject?.generated === "prettier-copy";

  let next = updated;
  let generatedEntries: readonly Record<string, unknown>[];
  if (formatting.choice === "managed") {
    // "Use Zedbee defaults" restores the bundled default policy: settings
    // Zedbee copied are removed, hand-written settings survive untouched.
    const value =
      settingsOwnedBySetup || existingObject === undefined
        ? { severity: existingSeverity, engine: "managed" }
        : { ...existingObject, engine: "managed" };
    next = applyEdits(
      next,
      modify(next, ["checks", "formatting"], value, options),
    );
    generatedEntries = [];
  } else if (formatting.choice === "off") {
    const value =
      settingsOwnedBySetup || existingObject === undefined
        ? "off"
        : { ...existingObject, severity: "off" };
    next = applyEdits(
      next,
      modify(next, ["checks", "formatting"], value, options),
    );
    generatedEntries = [];
  } else if (formatting.choice === "project") {
    // Project mode cannot keep managed settings active anywhere they would
    // combine with a project engine, so the settings block is reset.
    next = applyEdits(
      next,
      modify(
        next,
        ["checks", "formatting"],
        {
          engine: formatting.rootProject ? "project" : "managed",
          severity: existingSeverity,
        },
        options,
      ),
    );
    generatedEntries = engineOverrideEntries(formatting.projectRoots);
  } else {
    next = applyEdits(
      next,
      modify(
        next,
        ["checks", "formatting"],
        {
          severity: existingSeverity,
          settings: formatting.imported?.settings ?? {},
          generated: "prettier-copy",
        },
        options,
      ),
    );
    generatedEntries = importedOverrideEntries(formatting.imported);
  }

  // Repeat setup replaces exactly the entries Zedbee generated and preserves
  // every unmarked, hand-authored override.
  const existingOverrides = Array.isArray(root.overrides)
    ? (root.overrides as readonly unknown[])
    : [];
  const userOverrides = existingOverrides.filter(
    (entry) => !isGeneratedOverrideEntry(entry),
  );
  const finalOverrides = [...userOverrides, ...generatedEntries];
  if (
    existingOverrides.length !== finalOverrides.length ||
    existingOverrides.length !== userOverrides.length
  ) {
    next = applyEdits(
      next,
      modify(next, ["overrides"], finalOverrides, options),
    );
  }
  return next;
}


function existingVulnerabilitySeverity(
  before: string | null,
): "off" | "warn" | "error" | undefined {
  if (before === null) return undefined;
  const errors: ParseError[] = [];
  const root: unknown = parse(before, errors, { allowTrailingComma: true });
  if (
    errors.length > 0 ||
    typeof root !== "object" ||
    root === null ||
    Array.isArray(root)
  ) {
    return undefined;
  }
  const checks = (root as Record<string, unknown>).checks;
  if (typeof checks !== "object" || checks === null || Array.isArray(checks)) {
    return undefined;
  }
  const vulnerability = (checks as Record<string, unknown>).vulnerabilities;
  if (["off", "warn", "error"].includes(vulnerability as string)) {
    return vulnerability as "off" | "warn" | "error";
  }
  if (
    typeof vulnerability === "object" &&
    vulnerability !== null &&
    !Array.isArray(vulnerability)
  ) {
    const severity = (vulnerability as Record<string, unknown>).severity;
    if (["off", "warn", "error"].includes(severity as string)) {
      return severity as "off" | "warn" | "error";
    }
  }
  return undefined;
}

function environments(
  inspection: RepositoryInspection,
): readonly Environment[] {
  const detected = new Set(
    inspection.workspaces.flatMap((workspace) => workspace.environments),
  );
  return Object.freeze(
    ENVIRONMENT_ORDER.filter((environment) => detected.has(environment)),
  );
}

function recommendedChecks(
  inspection: RepositoryInspection,
  detected: readonly Environment[],
  profile: CreateInitProposalOptions["profile"],
): readonly CheckId[] {
  const checks = new Set(COMMON_CHECKS);
  if (detected.includes("typescript")) checks.add("types");
  if (
    detected.some((environment) =>
      ["react", "react-dom", "ink", "next", "remix"].includes(environment),
    )
  ) {
    checks.add("reactCorrectness");
  }
  if (
    detected.some((environment) =>
      ["react-dom", "next", "remix"].includes(environment),
    )
  ) {
    checks.add("reactAccessibility");
  }
  if (inspection.workspaces.length > 1) checks.add("dependencyArchitecture");
  if (inspection.lockfiles.length > 0) checks.add("vulnerabilities");
  const profileChecks = PROFILE_CHECKS[profile];
  return Object.freeze(
    CHECK_IDS.filter((check) => checks.has(check) && profileChecks.has(check)),
  );
}

export function createInitProposal(
  inspection: RepositoryInspection,
  options: CreateInitProposalOptions,
): InitProposal {
  const detected = environments(inspection);
  const before = options.configBefore ?? null;
  const selectedChecks =
    options.checks === undefined
      ? recommendedChecks(inspection, detected, options.profile)
      : Object.freeze(
          CHECK_IDS.filter((check) => options.checks?.includes(check)),
        );
  const vulnerabilityScanningAvailable = inspection.lockfiles.length > 0;
  const configuredVulnerabilitySeverity = existingVulnerabilitySeverity(before);
  const vulnerabilitiesEnabled =
    vulnerabilityScanningAvailable &&
    (options.checks === undefined
      ? configuredVulnerabilitySeverity === undefined
        ? selectedChecks.includes("vulnerabilities")
        : configuredVulnerabilitySeverity !== "off"
      : selectedChecks.includes("vulnerabilities"));
  const osvUnavailable = options.osvUnavailable ?? "block";
  // Repeat init preserves an existing explicit engine choice unless the user
  // selects a different one, so the preview never misstates current policy.
  const formattingChoice: InitFormattingChoice =
    options.formatting ?? existingFormattingChoice(before);
  const formattingConfig: FormattingConfigInput | undefined =
    options.formatting === undefined
      ? undefined
      : {
          choice: options.formatting,
          ...(options.formattingImport === undefined
            ? {}
            : { imported: options.formattingImport }),
          ...(options.formatting === "project"
            ? {
                projectRoots: options.formattingProjectRoots ?? [],
                rootProject: options.formattingRootProject ?? true,
              }
            : {}),
        };
  const config = initFileChange(
    ".zedbeerc.jsonc",
    before,
    configContents(
      options.profile,
      before,
      options.checks,
      vulnerabilitiesEnabled,
      osvUnavailable,
      formattingConfig,
    ),
    0o644,
  );
  const hook: ResolvedHookChoice =
    options.hook === "auto"
      ? "none"
      : options.hook === "tracked"
        ? "husky"
        : options.hook;
  const hookActivation = options.hookActivation ?? defaultHookActivation(hook);
  const files = [
    config,
    ...(options.hookChange === undefined ? [] : [options.hookChange]),
    ...(options.hookChanges ?? []),
  ];
  return Object.freeze({
    repositoryRoot: options.repositoryRoot,
    profile: options.profile,
    hook,
    hookActivation,
    ...(options.hooksPathChange === undefined
      ? {}
      : { hooksPathChange: options.hooksPathChange }),
    detectedEnvironments: detected,
    recommendedChecks: selectedChecks,
    vulnerabilityScanningAvailable,
    osvUnavailable,
    networkChecks: !vulnerabilitiesEnabled
      ? Object.freeze([])
      : Object.freeze([
          Object.freeze({
            id: "vulnerabilities" as const,
            usesNetwork: true,
            onUnavailable: osvUnavailable,
            disclosure: OSV_NETWORK_DISCLOSURE,
          }),
        ]),
    limitations: Object.freeze([
      "Recommendations are based on inspected manifests, source extensions, workspaces, and lockfiles; review the exact proposal before applying it.",
      "Initialization never installs packages or runs project lifecycle scripts.",
      "Generated hooks use npx --no-install, so Zedbee must remain installed in the project.",
      ...(hookActivation.status === "pending" &&
      hookActivation.remediation !== undefined
        ? [hookActivation.remediation]
        : []),
      ...(options.formattingImport?.limitations ?? []),
    ]),
    formatting: formattingChoice,
    ...(options.formattingImport === undefined
      ? {}
      : { formattingImport: options.formattingImport }),
    ...(options.formattingDetection === undefined
      ? {}
      : {
          formattingDetection: Object.freeze(
            options.formattingDetection.map((entry) => Object.freeze({ ...entry })),
          ),
        }),
    ...(formattingChoice === "project" &&
    options.projectPrettierTrustRoots !== undefined &&
    options.projectPrettierTrustRoots.length > 0
      ? { projectPrettierTrustRoots: options.projectPrettierTrustRoots }
      : {}),
    ...(formattingChoice === "project" &&
    options.projectPrettierTrustRoots !== undefined &&
    options.projectPrettierTrustRoots.length > 0 &&
    options.projectPrettierTrustConfirmed === true
      ? { projectPrettierTrustConfirmed: true }
      : {}),
    ...((formattingChoice === "managed" || formattingChoice === "off") &&
    options.projectPrettierRevokeRoots !== undefined &&
    options.projectPrettierRevokeRoots.length > 0
      ? { projectPrettierRevokeRoots: options.projectPrettierRevokeRoots }
      : {}),
    ...(options.executableEvaluatedConfig === undefined
      ? {}
      : { executableEvaluatedConfig: options.executableEvaluatedConfig }),
    files: Object.freeze(files),
  });
}
