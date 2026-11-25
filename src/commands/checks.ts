import { inspectionContext } from "../checks/dispatch-context.js";
import { useStaticDashboard } from "../reporting/static-dashboard.js";
import {
  joinSnapshotReaders,
  settleSnapshotWork,
} from "../git/snapshot-work.js";
import { readInstalledPackageVersion } from "../checks/engine-identity.js";
import { executionClassFor } from "../checks/applicability.js";
import type { CheckAdapter, InspectionContext } from "../checks/adapter.js";
import { configurationTextLines } from "../checks/configuration-presentation.js";
import type {
  CheckApplicabilityDescription,
  CheckConfigurationDescription,
  CheckDescription,
  EffectiveSettingDescription,
} from "../checks/description.js";
import { loadConfigFromIndex } from "../config/load-config.js";
import {
  CHECK_IDS,
  type CheckId,
  type ResolvedCheckPolicy,
  type ResolvedCheckPolicyPatch,
  type ResolvedConfig,
} from "../config/schema.js";
import { compareCodeUnits } from "../core/compare.js";
import { readStagedChangeSet } from "../git/change-set.js";
import { GitClient } from "../git/client.js";
import { captureSelectedIndexComparison } from "../git/selected-comparison.js";
import { buildSnapshotPair } from "../git/snapshot.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import { discoverProjectPrettier } from "../init/prettier-discovery.js";
import { DEFAULT_CHECK_ADAPTERS } from "../scan/run-scan.js";
import {
  immutableConfigurationSnapshot,
  isConfigurableRuleCheckId,
  managedPolicyScalarKeys,
  managedSettingDefinition,
} from "../config/settings-registry.js";
import type { SettingOrigin } from "../config/settings-definition.js";
import {
  resolveInspectionPolicy,
  resolveScheduledTargetPolicy,
} from "../checks/policy-scheduling.js";
import { createFilePolicyResolver } from "../config/file-policy.js";
import {
  terminalColorEnabled,
  terminalText,
} from "../renderers/terminal-style.js";

export type {
  CheckApplicabilityDescription,
  CheckConfigurationDescription,
  CheckDescription,
  EffectiveSettingDescription,
} from "../checks/description.js";

export type ChecksOutputFormat = "auto" | "text" | "json";

export interface ChecksCommandOptions {
  readonly cwd: string;
  readonly format: ChecksOutputFormat;
  readonly color: boolean;
  readonly configPath?: string;
}

export interface ChecksCommandIO {
  readonly stdoutIsTTY: boolean;
  readonly width: number;
  readonly env: Record<string, string | undefined>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface ChecksCommandResult {
  readonly exitCode: 0 | 2;
  readonly checks: readonly CheckDescription[];
}

export interface ChecksCommandDependencies {
  resolveRepositoryRoot(cwd: string): Promise<string>;
  loadConfig(
    repositoryRoot: string,
    configPath: string | undefined,
    git: GitClient,
  ): Promise<ResolvedConfig>;
  inspectChecks(
    repositoryRoot: string,
    config: ResolvedConfig,
    git: GitClient,
  ): Promise<ReadonlyMap<CheckId, CheckApplicabilityDescription>>;
  captureIndexComparison?: typeof captureSelectedIndexComparison;
  discoverProjectPrettier?: typeof discoverProjectPrettier;
  renderDashboard?(
    checks: readonly CheckDescription[],
    options: { readonly width: number; readonly color: boolean },
  ): Promise<void>;
}

interface CatalogEntry {
  readonly description: string;
  readonly engine: Omit<CheckDescription["engine"], "version"> &
    ({ readonly packages: readonly string[] } | { readonly version: string });
  readonly limitation: string;
  readonly automaticFix?: string;
}

const eslint = {
  name: "ESLint",
  packages: ["eslint"],
  license: "MIT",
} as const;
const CATALOG: Readonly<Record<CheckId, CatalogEntry>> = Object.freeze({
  formatting: {
    description: "Checks staged formatting.",
    engine: { name: "Prettier", packages: ["prettier"], license: "MIT" },
    limitation: "Reports formatting differences; scans do not modify files.",
    automaticFix: "zedbee fix formatting",
  },
  lint: {
    description: "Checks JavaScript and TypeScript correctness rules.",
    engine: eslint,
    limitation:
      "Uses Zedbee's managed rules and never loads project ESLint configuration.",
  },
  types: {
    description: "Checks TypeScript diagnostics in the staged workspace.",
    engine: {
      name: "TypeScript",
      packages: ["typescript"],
      license: "Apache-2.0",
    },
    limitation:
      "Requires a contained tsconfig.json and does not invent compiler settings.",
  },
  cyclomaticComplexity: {
    description: "Detects worsened cyclomatic complexity.",
    engine: eslint,
    limitation:
      "Measures syntax-level branch complexity, not runtime behavior.",
  },
  readabilityComplexity: {
    description: "Detects worsened readability complexity.",
    engine: {
      name: "ESLint + Zedbee rule",
      packages: ["eslint"],
      license: "MIT",
    },
    limitation:
      "This managed heuristic is intentionally not a Sonar Cognitive Complexity implementation.",
  },
  structuralSecurity: {
    description: "Finds high-confidence insecure JavaScript structures.",
    engine: { name: "ast-grep", packages: ["@ast-grep/napi"], license: "MIT" },
    limitation:
      "The built-in rules do not provide Semgrep-style taint, inter-file, or framework analysis.",
  },
  secrets: {
    description: "Finds secrets in the exact staged snapshot.",
    engine: {
      name: "Secretlint",
      packages: ["@secretlint/core"],
      license: "MIT",
    },
    limitation:
      "Scans changed regular UTF-8 files up to 1 MiB, not repository history; pattern matches can require human confirmation.",
  },
  duplication: {
    description: "Detects new and enlarged code clones.",
    engine: { name: "jscpd", packages: ["jscpd"], license: "MIT" },
    limitation:
      "Baseline comparison runs project analysis twice and small clones below managed thresholds are omitted.",
  },
  dependencyArchitecture: {
    description: "Detects new dependency graph violations.",
    engine: {
      name: "dependency-cruiser",
      packages: ["dependency-cruiser"],
      license: "MIT",
    },
    limitation:
      "Dynamic dependency construction can evade static graph resolution.",
  },
  deadCode: {
    description: "Detects newly unused code and dependency hygiene issues.",
    engine: { name: "Knip", packages: ["knip"], license: "ISC" },
    limitation:
      "Default Vite HTML modules and Next conventions are supported; custom Vite roots, inline/plugin entries, and dynamic conventions require explicit entryPoints.",
  },
  reactCorrectness: {
    description: "Checks React and Hooks correctness.",
    engine: {
      name: "ESLint React plugins",
      packages: ["eslint-plugin-react", "eslint-plugin-react-hooks"],
      license: "MIT",
    },
    limitation:
      "Calibrates from staged React dependency data and falls back to managed React 19.2 settings.",
  },
  reactAccessibility: {
    description: "Checks JSX accessibility for DOM React workspaces.",
    engine: {
      name: "eslint-plugin-jsx-a11y",
      packages: ["eslint-plugin-jsx-a11y"],
      license: "MIT",
    },
    limitation:
      "Static JSX rules cannot prove the accessibility of runtime interaction.",
  },
  vulnerabilities: {
    description: "Checks dependency lockfiles for known vulnerabilities.",
    engine: {
      name: "Zedbee OSV API client",
      version: "v1",
      license: "PolyForm-Small-Business-1.0.0",
    },
    limitation:
      "Online-only results depend on OSV availability, advisory freshness, and supported JavaScript lockfile data.",
  },
});

function describeManagedEngine(
  checkId: CheckId,
  versions: Map<string, string>,
): CheckDescription["engine"] {
  const { engine } = CATALOG[checkId];
  if ("version" in engine) return Object.freeze({ ...engine });
  const version = engine.packages
    .map((name) => {
      const cached = versions.get(name);
      if (cached !== undefined) return cached;
      const installed = readInstalledPackageVersion(name) ?? "Unavailable";
      versions.set(name, installed);
      return installed;
    })
    .join(" / ");
  return Object.freeze({ name: engine.name, license: engine.license, version });
}

async function inspectConfiguredChecks(
  repositoryRoot: string,
  config: ResolvedConfig,
  git: GitClient,
): Promise<ReadonlyMap<CheckId, CheckApplicabilityDescription>> {
  const changeSet = await readStagedChangeSet(git);
  const snapshots = await buildSnapshotPair(repositoryRoot, git);
  try {
    const [baselineInspection, targetInspection] = await settleSnapshotWork(
      () => inspectRepository(snapshots.baselineDir),
      () => inspectRepository(snapshots.targetDir),
    );
    const context: InspectionContext = {
      repositoryRoot,
      changeSet,
      config,
      baselineInspection,
      targetInspection,
    };
    const policyForFile = createFilePolicyResolver(config, changeSet);
    const entries = await joinSnapshotReaders(
      DEFAULT_CHECK_ADAPTERS.map(async (adapter: CheckAdapter) => {
        const id = adapter.id as CheckId;
        const applicability = await adapter.inspect(
          inspectionContext(context, id, resolveInspectionPolicy(config, id)),
        );
        const targets = applicability.applies
          ? (
              await joinSnapshotReaders(
                applicability.targets.map(async (target) =>
                  (await resolveScheduledTargetPolicy(
                    config,
                    id,
                    target,
                    context,
                    policyForFile,
                  )) !== undefined
                    ? target
                    : undefined,
                ),
              )
            ).filter((target) => target !== undefined)
          : [];
        return [
          id,
          applicability.applies && targets.length > 0
            ? {
                applicable: true,
                targets: targets
                  .map(({ id: targetId }) => targetId)
                  .sort(compareCodeUnits),
                executionClass: applicability.executionClass,
              }
            : {
                applicable: false,
                targets: [],
                executionClass: executionClassFor(id),
                reason: applicability.applies
                  ? "No applicable targets under the configured check policy"
                  : applicability.reason,
              },
        ] as const;
      }),
    );
    return new Map(entries);
  } finally {
    await snapshots.cleanup();
  }
}

const DEFAULT_DEPENDENCIES: ChecksCommandDependencies = {
  async resolveRepositoryRoot(cwd) {
    return (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"]))
      .stdout;
  },
  loadConfig: (repositoryRoot, configPath, git) =>
    loadConfigFromIndex(repositoryRoot, git, configPath),
  inspectChecks: inspectConfiguredChecks,
  captureIndexComparison: captureSelectedIndexComparison,
};

async function inspectSelectedChecks(
  repositoryRoot: string,
  configPath: string | undefined,
  dependencies: ChecksCommandDependencies,
) {
  const bootstrap = new GitClient(repositoryRoot);
  const selected = await dependencies.captureIndexComparison?.(bootstrap);
  try {
    const git = selected?.bind(bootstrap) ?? bootstrap;
    const config = await dependencies.loadConfig(
      repositoryRoot,
      configPath,
      git,
    );
    const applicability = await dependencies.inspectChecks(
      repositoryRoot,
      config,
      git,
    );
    return { config, applicability };
  } finally {
    await selected?.cleanup();
  }
}

async function renderDashboard(
  checks: readonly CheckDescription[],
  options: { readonly width: number; readonly color: boolean },
): Promise<void> {
  const { runInkChecks } = await import("../ui/checks-dashboard.js");
  await runInkChecks(checks, options);
}

function orderedRecord<T>(
  entries: readonly (readonly [string, T])[],
  preserveOrder = false,
) {
  const orderedEntries = preserveOrder
    ? entries
    : [...entries].sort(([left], [right]) => compareCodeUnits(left, right));
  return Object.freeze(Object.fromEntries(orderedEntries)) as Readonly<
    Record<string, T>
  >;
}

function repositoryValueSource(
  origin: SettingOrigin | undefined,
): EffectiveSettingDescription["source"] {
  return origin?.kind === "repository" ? "repository" : "profile";
}

function configurationValueSnapshot(value: unknown): unknown {
  return immutableConfigurationSnapshot(value);
}

function policyValueEntries(
  checkId: CheckId,
  policy: ResolvedCheckPolicy,
): readonly (readonly [string, unknown])[] {
  const entries: [string, unknown][] = [];
  for (const key of managedPolicyScalarKeys(checkId)) {
    if (key in policy) {
      entries.push([key, policy[key as keyof ResolvedCheckPolicy]]);
    }
  }
  if ("settings" in policy) {
    const settings = policy.settings as Readonly<Record<string, unknown>>;
    const definition = managedSettingDefinition(checkId);
    const settingKeys =
      definition === undefined ? [] : Object.keys(definition.describe);
    for (const key of settingKeys) {
      if (settings[key] !== undefined)
        entries.push([`settings.${key}`, settings[key]]);
    }
  }
  if ("rules" in policy && isConfigurableRuleCheckId(checkId)) {
    for (const key of Object.keys(policy.rules).sort(compareCodeUnits)) {
      entries.push([`rules.${key}`, policy.rules[key]]);
    }
  }
  return entries;
}

function patchValueEntries(
  checkId: CheckId,
  patch: ResolvedCheckPolicyPatch,
): readonly (readonly [string, unknown])[] {
  const entries: [string, unknown][] = [];
  for (const key of ["severity", "when", ...managedPolicyScalarKeys(checkId)]) {
    if (key in patch) {
      entries.push([key, patch[key as keyof ResolvedCheckPolicyPatch]]);
    }
  }
  if (patch.settings !== undefined) {
    for (const key of Object.keys(patch.settings).sort(compareCodeUnits)) {
      entries.push([
        `settings.${key}`,
        (patch.settings as Readonly<Record<string, unknown>>)[key],
      ]);
    }
  }
  if (patch.rules !== undefined && isConfigurableRuleCheckId(checkId)) {
    for (const key of Object.keys(patch.rules).sort(compareCodeUnits)) {
      entries.push([`rules.${key}`, patch.rules[key]]);
    }
  }
  return entries;
}

function describeConfiguration(
  checkId: CheckId,
  config: ResolvedConfig,
): CheckConfigurationDescription {
  const values = orderedRecord(
    policyValueEntries(checkId, config.checks[checkId]).map(([key, value]) => {
      const source = repositoryValueSource(
        config.configurationOrigins[checkId][key],
      );
      return [
        key,
        Object.freeze({
          value: configurationValueSnapshot(value),
          source,
          customized: source === "repository",
        }),
      ] as const;
    }),
    checkId === "formatting",
  );
  const overrides = Object.freeze(
    config.overrides
      .map((override) => {
        const patch = override.checks[checkId];
        if (patch === undefined) return undefined;
        return Object.freeze({
          files: Object.freeze([...override.files]),
          ...(override.excludeFiles === undefined
            ? {}
            : { excludeFiles: Object.freeze([...override.excludeFiles]) }),
          values: orderedRecord(
            patchValueEntries(checkId, patch).map(([key, value]) => [
              key,
              configurationValueSnapshot(value),
            ]),
          ),
        });
      })
      .filter(
        (
          override,
        ): override is Readonly<{
          readonly files: readonly string[];
          readonly excludeFiles?: readonly string[];
          readonly values: Readonly<Record<string, unknown>>;
        }> => override !== undefined,
      ),
  );
  return Object.freeze({
    customized:
      Object.values(values).some(({ customized }) => customized) ||
      overrides.length > 0,
    values,
    overrides,
  });
}

function renderText(result: ChecksCommandResult, color: boolean): string {
  return `${result.checks
    .map((check) => {
      const targets =
        check.targets.length === 0 ? "none" : check.targets.join(", ");
      const configurationLines = configurationTextLines(
        check.configuration,
        check.id === "formatting" ? "settings." : undefined,
      )
        .map((line) => `  ${line}`)
        .join("\n");
      const header = terminalText(check.id, "primary", color);
      const body = [
        terminalText(`  ${check.description}`, "secondary", color),
        terminalText(`  Limitation: ${check.limitation}`, "secondary", color),
        terminalText(
          `  [${check.severity}/${check.timing}] ${check.applicability}; ${check.executionClass}; targets: ${targets}; engine: ${check.engine.name} ${check.engine.version} (${check.engine.license}); network: ${check.network}`,
          "secondary",
          color,
        ),
        ...(check.effectiveEngines !== undefined &&
        check.effectiveEngines.length > 1
          ? check.effectiveEngines.map((engine) =>
              terminalText(
                `  Engine scope ${engine.projectRoot}: ${engine.name} ${engine.version} (${engine.license})`,
                "secondary",
                color,
              ),
            )
          : []),
        ...configurationLines
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => terminalText(line, "secondary", color)),
        ...(check.automaticFix === undefined
          ? []
          : [
              terminalText(
                `  Automatic fix: ${check.automaticFix}`,
                "secondary",
                color,
              ),
            ]),
        ...(check.reason === undefined
          ? []
          : [terminalText(`  Reason: ${check.reason}`, "reason", color)]),
      ];
      return [header, ...body].join("\n");
    })
    .join("\n\n")}\n`;
}

export async function executeChecksCommand(
  options: ChecksCommandOptions,
  io: ChecksCommandIO,
  dependencies: ChecksCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<ChecksCommandResult> {
  try {
    const repositoryRoot = await dependencies.resolveRepositoryRoot(
      options.cwd,
    );
    const { config, applicability } = await inspectSelectedChecks(
      repositoryRoot,
      options.configPath,
      dependencies,
    );
    const lintUsesProject =
      config.checks.lint.engine === "project" ||
      config.overrides.some(
        (override) => override.checks.lint?.engine === "project",
      );
    const formattingUsesProject =
      config.checks.formatting.engine === "project" ||
      config.overrides.some(
        (override) => override.checks.formatting?.engine === "project",
      );
    const discoveredProjectPrettier = formattingUsesProject
      ? await (dependencies.discoverProjectPrettier ?? discoverProjectPrettier)(
          repositoryRoot,
        ).catch(() => [] as const)
      : [];
    const formattingUsesManaged =
      config.checks.formatting.engine === "managed" ||
      config.overrides.some(
        (override) => override.checks.formatting?.engine === "managed",
      );
    const engineVersions = new Map<string, string>();
    const effectiveFormattingEngines = Object.freeze([
      ...(formattingUsesManaged
        ? [
            Object.freeze({
              kind: "managed" as const,
              projectRoot: ".",
              ...describeManagedEngine("formatting", engineVersions),
            }),
          ]
        : []),
      ...discoveredProjectPrettier.map((entry) =>
        Object.freeze({
          kind: "project" as const,
          projectRoot: entry.projectRoot,
          name: "Project Prettier",
          version: entry.version ?? entry.status,
          license: "project-installed",
        }),
      ),
      ...(formattingUsesProject && discoveredProjectPrettier.length === 0
        ? [
            Object.freeze({
              kind: "project" as const,
              projectRoot: ".",
              name: "Project Prettier",
              version: "missing",
              license: "project-installed",
            }),
          ]
        : []),
    ]);
    const formattingEngine =
      effectiveFormattingEngines.length === 1
        ? Object.freeze({
            name: effectiveFormattingEngines[0]!.name,
            version: effectiveFormattingEngines[0]!.version,
            license: effectiveFormattingEngines[0]!.license,
          })
        : Object.freeze({
            name: "Mixed Prettier engines",
            version: `${effectiveFormattingEngines.length} configurations`,
            license: "mixed",
          });
    const checks = Object.freeze(
      CHECK_IDS.map((id): CheckDescription => {
        const runtime = applicability.get(id) ?? {
          applicable: false,
          targets: [],
          executionClass: executionClassFor(id),
          reason: "Check applicability was not reported.",
        };
        const policy = config.checks[id];
        return Object.freeze({
          id,
          description: CATALOG[id].description,
          severity: policy.severity,
          timing: policy.when,
          applicability: runtime.applicable ? "applicable" : "not-applicable",
          targets: Object.freeze([...runtime.targets]),
          executionClass: runtime.executionClass,
          network:
            id !== "vulnerabilities" ? "none" : "online-package-metadata-only",
          engine:
            id === "formatting"
              ? formattingEngine
              : describeManagedEngine(id, engineVersions),
          ...(id === "formatting"
            ? { effectiveEngines: effectiveFormattingEngines }
            : {}),
          limitation:
            id === "lint" && lintUsesProject
              ? "Uses project ESLint configuration in selected workspaces under explicit trust; other workspaces retain managed rules. Project-rule automatic fixes are unavailable."
              : id === "formatting" && formattingUsesProject
                ? "Uses the project's installed Prettier, native configuration, and plugins under explicit trust."
                : CATALOG[id].limitation,
          ...(CATALOG[id].automaticFix === undefined
            ? {}
            : { automaticFix: CATALOG[id].automaticFix }),
          configuration: describeConfiguration(id, config),
          ...(runtime.reason === undefined ? {} : { reason: runtime.reason }),
        });
      }),
    );
    const result = Object.freeze({ exitCode: 0 as const, checks });
    const dashboard = useStaticDashboard(options.format, io);
    if (options.format === "json") {
      io.writeStdout(`${JSON.stringify(result, null, 2)}\n`);
    } else if (dashboard) {
      await (dependencies.renderDashboard ?? renderDashboard)(result.checks, {
        width: io.width,
        color: options.color && io.env.NO_COLOR === undefined,
      });
    } else {
      io.writeStdout(
        renderText(
          result,
          terminalColorEnabled(options.color, io.stdoutIsTTY, io.env),
        ),
      );
    }
    return result;
  } catch {
    io.writeStderr("Zedbee could not describe the configured checks.\n");
    return Object.freeze({ exitCode: 2, checks: Object.freeze([]) });
  }
}
