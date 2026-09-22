import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { GitClient } from "../git/client.js";
import {
  detectHookIntegration,
  type DetectedHookIntegration,
} from "../hooks/detect.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import { captureSnapshotRegistry } from "../inspection/snapshot-registry.js";
import type { RepositoryInspection } from "../inspection/types.js";
import { RepositoryInspectionError } from "../inspection/types.js";
import { createInitProposal } from "../init/recommend.js";
import type {
  CreateInitProposalOptions,
  ExecutableEvaluatedConfig,
  InitFormattingChoice,
  InitFormattingDetection,
  InitFormattingImport,
  InitHookChoice,
  InitOsvUnavailable,
  InitProposal,
} from "../init/types.js";
import type {
  ImportableNativeConfig,
  ImportedFormattingOverride,
} from "../checks/prettier/project-types.js";
import { applyInitProposal } from "../init/write-config.js";
import { discoverProjectPrettier } from "../init/prettier-discovery.js";
import { previewPrettierSettingsImport } from "../init/prettier-import.js";
import { editorConfigImport } from "../init/prettier-editorconfig.js";
import { buildSnapshotPair } from "../git/snapshot.js";
import {
  readProjectPrettierTrust,
  requireProjectPrettierTrust,
} from "../checks/prettier/project-trust.js";
import {
  openProjectFormatter,
  resolveProjectPrettierInstallation,
} from "../checks/prettier/project-engine.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../checks/prettier/settings.js";
import { CHECK_IDS, type CheckId, type ProfileId } from "../config/schema.js";

export interface InitCommandOptions {
  readonly cwd: string;
  readonly profile: ProfileId;
  readonly hook: InitHookChoice;
  readonly checks?: readonly CheckId[];
  readonly osvUnavailable?: InitOsvUnavailable;
  readonly formatting?: InitFormattingChoice;
  readonly trustProjectPrettier?: boolean;
  readonly yes: boolean;
  readonly format: "text" | "json";
  readonly color: boolean;
  readonly animations: boolean;
  readonly signal?: AbortSignal;
}

export interface InitCommandIO {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly width: number;
  readonly env: Record<string, string | undefined>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface InitPromptOptions {
  readonly width: number;
  readonly color: boolean;
  readonly animations: boolean;
  /** Deterministic render seam for tests; production resolves Ink's live size. */
  readonly terminalSize?: Readonly<{ columns: number; rows: number }>;
}

export interface InitCommandDependencies {
  resolveRepositoryRoot(cwd: string): Promise<string>;
  inspect(repositoryRoot: string): Promise<RepositoryInspection>;
  confirm(
    proposal: InitProposal,
    options: InitPromptOptions,
    proposalForSelection: (
      profile: ProfileId,
      checks: readonly CheckId[] | undefined,
      osvUnavailable: InitOsvUnavailable,
      hook?: InitHookChoice,
      formatting?: InitFormattingChoice,
      projectTrust?: boolean,
      evaluatedImport?: InitFormattingImport,
    ) => InitProposal,
    evaluateExecutableImport?: () => Promise<InitFormattingImport | undefined>,
  ): Promise<false | InitProposal>;
}

const DEFAULT_DEPENDENCIES: InitCommandDependencies = {
  async resolveRepositoryRoot(cwd) {
    return (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"]))
      .stdout;
  },
  inspect: inspectRepository,
  async confirm(
    proposal,
    options,
    proposalForSelection,
    evaluateExecutableImport,
  ) {
    const { runInitPrompt } = await import("../ui/init-app.js");
    return runInitPrompt(
      proposal,
      options,
      proposalForSelection,
      evaluateExecutableImport,
    );
  },
};

async function existingConfig(repositoryRoot: string): Promise<string | null> {
  const path = join(repositoryRoot, ".zedbeerc.jsonc");
  try {
    const state = await lstat(path);
    if (state.isSymbolicLink() || !state.isFile()) {
      throw new Error("unsafe config");
    }
    return readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function publicProposal(proposal: InitProposal) {
  return {
    profile: proposal.profile,
    hook: proposal.hook,
    hookActivation: proposal.hookActivation,
    ...(proposal.hooksPathChange === undefined
      ? {}
      : { hooksPathChange: proposal.hooksPathChange }),
    detectedEnvironments: proposal.detectedEnvironments,
    recommendedChecks: proposal.recommendedChecks,
    formatting: proposal.formatting ?? "managed",
    ...(proposal.formattingDetection === undefined
      ? {}
      : { formattingDetection: proposal.formattingDetection }),
    ...(proposal.formattingImport === undefined
      ? {}
      : {
          formattingImport: {
            settings: proposal.formattingImport.settings,
            overrides: proposal.formattingImport.overrides,
            limitations: proposal.formattingImport.limitations,
          },
        }),
    vulnerabilityScanningAvailable: proposal.vulnerabilityScanningAvailable,
    osvUnavailable: proposal.osvUnavailable,
    networkChecks: proposal.networkChecks,
    limitations: proposal.limitations,
    files: proposal.files.map(
      ({ relativePath, beforeHash, afterHash, diff, mode }) => ({
        relativePath,
        beforeHash,
        afterHash,
        diff,
        mode,
      }),
    ),
  };
}

function renderText(proposal: InitProposal, applied: boolean): string {
  const lines = [
    applied
      ? "Zedbee initialization applied."
      : "Zedbee initialization preview.",
    `Profile: ${proposal.profile}`,
    `Hook: ${proposal.hook}`,
    `Hook activation: ${proposal.hookActivation.status} — ${proposal.hookActivation.message}`,
    `Detected: ${proposal.detectedEnvironments.join(", ") || "none"}`,
    `Recommended checks: ${proposal.recommendedChecks.join(", ") || "none"}`,
    `Formatting: ${proposal.formatting ?? "managed"}`,
    ...(proposal.formattingDetection ?? []).map(
      (entry) =>
        `Prettier setup: ${
          entry.projectRoot === "." ? "repository root" : entry.projectRoot
        } — ${entry.status}${
          entry.version === undefined ? "" : ` (Prettier ${entry.version})`
        }${entry.executableConfig ? "; executable configuration" : ""}`,
    ),
    ...(proposal.formattingDetection !== undefined &&
    proposal.formattingDetection.length === 0
      ? ["Prettier setup: none detected; Zedbee keeps its managed formatter."]
      : []),
    ...(proposal.vulnerabilityScanningAvailable
      ? [`OSV unavailable: ${proposal.osvUnavailable}`]
      : []),
  ];
  for (const network of proposal.networkChecks) {
    lines.push(`Network: ${network.disclosure}`);
  }
  if (proposal.hookActivation.remediation !== undefined) {
    lines.push(
      `Hook activation required: ${proposal.hookActivation.remediation}`,
    );
  }
  for (const file of proposal.files) lines.push("", file.diff);
  if (proposal.hooksPathChange !== undefined)
    lines.push(
      `Git configuration: core.hooksPath → ${proposal.hooksPathChange.after}`,
    );
  if (!applied) lines.push("", "No files were written without confirmation.");
  return `${lines.join("\n")}\n`;
}

function renderInitFailure(error: unknown): string {
  const lines = ["Zedbee could not initialize this repository safely."];
  if (
    error instanceof RepositoryInspectionError &&
    error.code === "UNSAFE_SNAPSHOT_PATH"
  ) {
    lines.push(
      "Reason: Repository inspection found a symbolic link that leaves the repository.",
      "Remediation: Remove the external link or move it into a directory Zedbee ignores.",
    );
  } else if (error instanceof ProjectPrettierTrustRequiredError) {
    lines.push(`Reason: ${error.message}`);
    lines.push(
      "Remediation: Re-run zedbee init with --trust-project-prettier, or run interactively to review the execution disclosure.",
    );
  } else if (
    error instanceof Error &&
    error.message.includes("unresolved limitations")
  ) {
    lines.push(`Reason: ${error.message}`);
    lines.push(
      "Remediation: Run zedbee init interactively to review and accept the settings-copy limitations.",
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderInteractiveResult(
  confirmed: boolean,
  proposal: InitProposal,
): string {
  if (!confirmed) return "Zedbee initialization cancelled\n";
  const lines = ["Zedbee initialized successfully"];
  if (proposal.hookActivation.remediation !== undefined) {
    lines.push(`Next step: ${proposal.hookActivation.remediation}`);
  }
  return `${lines.join("\n")}\n`;
}

interface FormattingSetup {
  readonly imported: InitFormattingImport;
  readonly detection: readonly InitFormattingDetection[];
  /** Primary project used for messages and executable-config evaluation. */
  readonly projectRoot: string;
  /** Every discovered project root; project mode enables each of them. */
  readonly projectRoots: readonly string[];
  /** Roots that already hold a local executable-code grant. */
  readonly storedTrustRoots: readonly string[];
}
async function resolveFormattingSetup(
  repositoryRoot: string,
): Promise<FormattingSetup> {
  // Discovery failures are reported; they are never converted into an empty
  // setup that would misrepresent the project.
  const discoveries = await discoverProjectPrettier(repositoryRoot);
  const projectRoots = discoveries.map((entry) => entry.projectRoot);
  const storedTrustRoots: string[] = [];
  for (const root of projectRoots) {
    const stored = await readProjectPrettierTrust(repositoryRoot, root).catch(
      () => undefined,
    );
    if (stored === "v1") storedTrustRoots.push(root);
  }
  const projectRoot =
    discoveries.find((entry) => entry.projectRoot === ".")?.projectRoot ??
    discoveries[0]?.projectRoot ??
    ".";
  const sharedConfigs = new Map(
    await Promise.all(
      discoveries.map(
        async (entry) =>
          [
            entry.projectRoot,
            await readSharedConfigSpecifier(repositoryRoot, entry.projectRoot),
          ] as const,
      ),
    ),
  );
  const detection = Object.freeze(
    discoveries.map((entry) => {
      const sharedConfig = sharedConfigs.get(entry.projectRoot);
      return Object.freeze({
        projectRoot: entry.projectRoot,
        ...(entry.version === undefined ? {} : { version: entry.version }),
        status: entry.status,
        executableConfig: entry.executableConfig,
        configPaths: Object.freeze([...entry.configPaths]),
        ...(sharedConfig === undefined ? {} : { sharedConfig }),
      });
    }),
  );
  const preview = await previewPrettierSettingsImport(repositoryRoot);
  const limitations = [...preview.limitations];
  return Object.freeze({
    imported: Object.freeze({
      settings: preview.settings,
      overrides: preview.overrides,
      ...(preview.pathExclusions === undefined
        ? {}
        : { pathExclusions: preview.pathExclusions }),
      limitations: Object.freeze(limitations),
    }),
    detection,
    projectRoot,
    projectRoots: Object.freeze(projectRoots),
    storedTrustRoots: Object.freeze(storedTrustRoots),
  });
}

/** Data-only read of a project's package.json#prettier shared-config string. */
async function readSharedConfigSpecifier(
  repositoryRoot: string,
  projectRoot: string,
): Promise<string | undefined> {
  try {
    const manifestPath = join(
      repositoryRoot,
      projectRoot === "." ? "" : projectRoot,
      "package.json",
    );
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.size > 1024n * 1024n) return undefined;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      prettier?: unknown;
    };
    return typeof manifest.prettier === "string"
      ? manifest.prettier
      : undefined;
  } catch {
    return undefined;
  }
}

class ProjectPrettierTrustRequiredError extends Error {
  readonly projectRoot: string;
  constructor(projectRoot: string) {
    super(
      `Using the project's Prettier in ${
        projectRoot === "." ? "the repository root" : projectRoot
      } requires explicit trust. Re-run with --trust-project-prettier or interactively.`,
    );
    this.name = "ProjectPrettierTrustRequiredError";
    this.projectRoot = projectRoot;
  }
}

function normalizeEvaluatedOverrides(
  imported: ImportableNativeConfig,
  configRoot: string,
): readonly ImportedFormattingOverride[] {
  const scopePattern = (pattern: string): string => {
    const relative = pattern.includes("/") ? pattern : `**/${pattern}`;
    return configRoot === "." ? relative : posix.join(configRoot, relative);
  };
  const overrides: ImportedFormattingOverride[] = [];
  for (const entry of imported.overrides) {
    const files = typeof entry.files === "string" ? [entry.files] : entry.files;
    const excludeFiles =
      typeof entry.excludeFiles === "string"
        ? [entry.excludeFiles]
        : (entry.excludeFiles ?? []);
    overrides.push(
      Object.freeze({
        files: Object.freeze(files.map(scopePattern)),
        excludeFiles: Object.freeze(excludeFiles.map(scopePattern)),
        settings: entry.settings,
      }),
    );
  }
  return Object.freeze(overrides);
}

interface EvaluatedExecutableImport {
  readonly imported: InitFormattingImport;
  /** Exact working-copy bytes the evaluation was bound to. */
  readonly evaluatedConfig: ExecutableEvaluatedConfig;
}

/**
 * Separately consented one-time evaluation of an executable or shared Prettier
 * configuration. Setup deliberately differs from scans: it evaluates the exact
 * working-copy bytes the preview showed — not a rebuilt Git snapshot — through
 * the same supervised project runner, and returns only supported plain values.
 * Anything not representable is reported as a limitation. The evaluated bytes
 * are recorded so apply can refuse if the configuration changed afterwards.
 */
async function evaluateExecutableProjectConfig(
  repositoryRoot: string,
  projectRoot: string,
  target: { readonly configPath: string } | { readonly sharedConfig: string },
  signal: AbortSignal,
): Promise<EvaluatedExecutableImport> {
  const permit = await requireProjectPrettierTrust(
    repositoryRoot,
    projectRoot,
    true,
  );
  const installation = await resolveProjectPrettierInstallation(
    repositoryRoot,
    projectRoot,
    repositoryRoot,
  );
  const session = await openProjectFormatter({
    checkoutRoot: await realpath(repositoryRoot),
    snapshotRoot: repositoryRoot,
    projectRoot,
    installation,
    permit,
    signal,
  });
  try {
    const imported =
      "configPath" in target
        ? await session.readConfigForImport(target.configPath)
        : await session.readSharedConfigForImport(target.sharedConfig);
    const limitations = [...imported.limitations];
    const boundPath =
      "configPath" in target
        ? target.configPath
        : projectRoot === "."
          ? "package.json"
          : `${projectRoot}/package.json`;
    const configRoot =
      "configPath" in target
        ? posix.dirname(target.configPath) || "."
        : projectRoot;
    const editorConfig = await editorConfigImport(
      await captureSnapshotRegistry(await realpath(repositoryRoot)),
      configRoot,
    );
    const overrides = normalizeEvaluatedOverrides(imported, configRoot);
    const editorOverrides = editorConfig.overrides.map((override) =>
      Object.freeze({
        ...override,
        settings: Object.freeze(
          Object.fromEntries(
            Object.entries(override.settings).filter(
              ([key]) => !(key in imported.settings),
            ),
          ),
        ) as Partial<ImportableNativeConfig["settings"]>,
      }),
    );
    const boundBytes = await readFile(join(repositoryRoot, boundPath), "utf8");
    return Object.freeze({
      imported: Object.freeze({
        settings: Object.freeze({
          ...editorConfig.settings,
          ...imported.settings,
        }),
        overrides: Object.freeze([...editorOverrides, ...overrides]),
        limitations: Object.freeze([
          ...editorConfig.limitations,
          ...limitations,
        ]),
      }),
      evaluatedConfig: Object.freeze({
        path: boundPath,
        sha256: createHash("sha256").update(boundBytes, "utf8").digest("hex"),
      }),
    });
  } finally {
    await session.close();
  }
}

/** Replaces only the evaluated scope and retains imports from other scopes. */
function mergeEvaluatedExecutableImport(
  base: InitFormattingImport,
  evaluated: EvaluatedExecutableImport,
  projectRoot: string,
): EvaluatedExecutableImport {
  const configRoot = evaluated.evaluatedConfig.path.endsWith("package.json")
    ? projectRoot
    : posix.dirname(evaluated.evaluatedConfig.path) || ".";
  const evaluatedPath = evaluated.evaluatedConfig.path;
  const evaluatedLimitation = evaluatedPath.endsWith("package.json")
    ? `The package.json Prettier field in ${evaluatedPath} references a shared configuration that cannot be copied as inert settings.`
    : `The Prettier configuration ${evaluatedPath} is executable; its dynamic values cannot be copied as inert settings.`;
  const limitations = Object.freeze([
    ...base.limitations.filter(
      (limitation) => limitation !== evaluatedLimitation,
    ),
    ...evaluated.imported.limitations,
  ]);
  if (configRoot === ".") {
    return Object.freeze({
      evaluatedConfig: evaluated.evaluatedConfig,
      imported: Object.freeze({
        settings: evaluated.imported.settings,
        ...(base.pathExclusions === undefined
          ? {}
          : { pathExclusions: base.pathExclusions }),
        overrides: Object.freeze([
          ...evaluated.imported.overrides,
          ...base.overrides,
        ]),
        limitations,
      }),
    });
  }

  const scope = `${configRoot}/**`;
  let replaced = false;
  const overrides: ImportedFormattingOverride[] = [];
  for (const override of base.overrides) {
    if (
      !replaced &&
      override.files.length === 1 &&
      override.files[0] === scope
    ) {
      replaced = true;
      overrides.push(
        Object.freeze({
          files: override.files,
          excludeFiles: override.excludeFiles,
          settings: Object.freeze({
            ...DEFAULT_FORMATTING_SETTINGS,
            ...evaluated.imported.settings,
          }),
        }),
        ...evaluated.imported.overrides,
      );
    } else {
      overrides.push(override);
    }
  }
  if (!replaced) {
    overrides.push(
      Object.freeze({
        files: Object.freeze([scope]),
        excludeFiles: Object.freeze([]),
        settings: Object.freeze({
          ...DEFAULT_FORMATTING_SETTINGS,
          ...evaluated.imported.settings,
        }),
      }),
      ...evaluated.imported.overrides,
    );
  }
  return Object.freeze({
    evaluatedConfig: evaluated.evaluatedConfig,
    imported: Object.freeze({
      settings: base.settings,
      ...(base.pathExclusions === undefined
        ? {}
        : { pathExclusions: base.pathExclusions }),
      overrides: Object.freeze(overrides),
      limitations,
    }),
  });
}

interface ExecutableConfigTarget {
  readonly projectRoot: string;
  readonly target:
    { readonly configPath: string } | { readonly sharedConfig: string };
}

function executableConfigTargets(
  detection: readonly InitFormattingDetection[],
): readonly ExecutableConfigTarget[] {
  const targets: ExecutableConfigTarget[] = [];
  for (const entry of detection) {
    const configPath = entry.configPaths.find(
      (path) => path !== "package.json",
    );
    if (entry.executableConfig && configPath !== undefined) {
      targets.push({ projectRoot: entry.projectRoot, target: { configPath } });
    } else if (entry.sharedConfig !== undefined) {
      targets.push({
        projectRoot: entry.projectRoot,
        target: { sharedConfig: entry.sharedConfig },
      });
    }
  }
  return Object.freeze(targets);
}

interface EvaluatedExecutableImports {
  readonly imported: InitFormattingImport;
  readonly evaluatedConfigs: readonly ExecutableEvaluatedConfig[];
}

async function evaluateExecutableProjectConfigs(
  repositoryRoot: string,
  base: InitFormattingImport,
  targets: readonly ExecutableConfigTarget[],
  signal: AbortSignal,
): Promise<EvaluatedExecutableImports> {
  let imported = base;
  const evaluatedConfigs: ExecutableEvaluatedConfig[] = [];
  for (const { projectRoot, target } of targets) {
    const evaluated = await evaluateExecutableProjectConfig(
      repositoryRoot,
      projectRoot,
      target,
      signal,
    );
    const merged = mergeEvaluatedExecutableImport(
      imported,
      evaluated,
      projectRoot,
    );
    imported = merged.imported;
    evaluatedConfigs.push(merged.evaluatedConfig);
  }
  return Object.freeze({
    imported,
    evaluatedConfigs: Object.freeze(evaluatedConfigs),
  });
}

export async function executeInitCommand(
  options: InitCommandOptions,
  io: InitCommandIO,
  dependencies: InitCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<0 | 2> {
  try {
    const repositoryRoot = await dependencies.resolveRepositoryRoot(
      options.cwd,
    );
    const canPrompt =
      !options.yes &&
      options.format === "text" &&
      io.stdinIsTTY &&
      io.stdoutIsTTY;
    const [inspection, hookIntegration, configBefore] = await Promise.all([
      dependencies.inspect(repositoryRoot),
      detectHookIntegration(repositoryRoot, options.hook),
      existingConfig(repositoryRoot),
    ]);
    const formattingSetup = await resolveFormattingSetup(repositoryRoot);
    // Project mode enables every discovered project; a non-interactive run
    // needs invocation consent or an existing grant for each of them.
    if (
      options.formatting === "project" &&
      !options.trustProjectPrettier &&
      !canPrompt &&
      formattingSetup.projectRoots.some(
        (root) => !formattingSetup.storedTrustRoots.includes(root),
      )
    ) {
      throw new ProjectPrettierTrustRequiredError(formattingSetup.projectRoot);
    }
    // Package.json#prettier string references name a shared configuration
    // package; both executable file forms and shared packages get the same
    // separately consented one-time evaluation. Without consent, the copy
    // keeps its limitation.
    const executableTargets = executableConfigTargets(
      formattingSetup.detection,
    );
    const evaluatedExecutableImports =
      options.formatting === "copy" &&
      options.trustProjectPrettier &&
      executableTargets.length > 0
        ? await evaluateExecutableProjectConfigs(
            repositoryRoot,
            formattingSetup.imported,
            executableTargets,
            options.signal ?? new AbortController().signal,
          )
        : undefined;
    const evaluateExecutableImport =
      canPrompt && executableTargets.length > 0
        ? async () =>
            evaluateExecutableProjectConfigs(
              repositoryRoot,
              formattingSetup.imported,
              executableTargets,
              options.signal ?? new AbortController().signal,
            )
        : undefined;
    const effectiveCopyImport =
      evaluatedExecutableImports?.imported ?? formattingSetup.imported;
    const effectiveEvaluatedConfigs =
      evaluatedExecutableImports?.evaluatedConfigs;
    // Interactive evaluation records the same byte binding when the UI's
    // evaluated import is used, so apply rechecks what the user previewed.
    let interactiveEvaluatedConfigs:
      readonly ExecutableEvaluatedConfig[] | undefined;
    const evaluateExecutableImportForUi =
      evaluateExecutableImport === undefined
        ? undefined
        : async () => {
            const result = await evaluateExecutableImport();
            interactiveEvaluatedConfigs = result.evaluatedConfigs;
            return result.imported;
          };
    if (
      options.formatting === "copy" &&
      !canPrompt &&
      effectiveCopyImport.limitations.length > 0
    ) {
      throw new Error(
        "The settings copy has unresolved limitations and cannot be applied noninteractively.",
      );
    }
    const enabledProjectRoots = formattingSetup.projectRoots.filter(
      (root) => root !== ".",
    );
    const formattingProposalFields = {
      // Detection is always reported, even when nothing is imported/executed.
      formattingDetection: formattingSetup.detection,
      ...(options.formatting === undefined
        ? {}
        : { formatting: options.formatting }),
      ...(options.formatting === "copy"
        ? { formattingImport: effectiveCopyImport }
        : {}),
      ...(options.formatting === "project"
        ? {
            formattingProjectRoots: enabledProjectRoots,
            formattingRootProject: formattingSetup.projectRoots.includes("."),
          }
        : {}),
      ...(options.formatting === "project" && options.trustProjectPrettier
        ? {
            projectPrettierTrustRoots: formattingSetup.projectRoots,
            projectPrettierTrustConfirmed: true,
          }
        : {}),
      ...((options.formatting === "managed" || options.formatting === "off") &&
      formattingSetup.storedTrustRoots.length > 0
        ? { projectPrettierRevokeRoots: formattingSetup.storedTrustRoots }
        : {}),
      ...(effectiveEvaluatedConfigs === undefined
        ? {}
        : { executableEvaluatedConfigs: effectiveEvaluatedConfigs }),
    };
    const proposalBaseOptions = {
      repositoryRoot,
      hook: hookIntegration.hook,
      configBefore,
      ...(hookIntegration.change === undefined
        ? {}
        : { hookChange: hookIntegration.change }),
      hookActivation: hookIntegration.activation,
      hookChanges: hookIntegration.changes,
      hooksPathChange: hookIntegration.hooksPathChange,
    };
    const proposalOptions: CreateInitProposalOptions = {
      ...proposalBaseOptions,
      ...formattingProposalFields,
      profile: options.profile,
      ...(options.checks === undefined ? {} : { checks: options.checks }),
      ...(options.osvUnavailable === undefined
        ? {}
        : { osvUnavailable: options.osvUnavailable }),
    };
    let proposal = createInitProposal(inspection, proposalOptions);
    const color = options.color && io.env.NO_COLOR === undefined;
    let confirmed = options.yes;
    let promptedInteractively = false;
    if (
      !confirmed &&
      options.format === "text" &&
      io.stdinIsTTY &&
      io.stdoutIsTTY
    ) {
      promptedInteractively = true;
      const integrations = new Map<InitHookChoice, DetectedHookIntegration>([
        [hookIntegration.hook, hookIntegration],
      ]);
      integrations.set(
        "none",
        await detectHookIntegration(repositoryRoot, "none"),
      );
      let selection: InitHookChoice = hookIntegration.hook;
      let choices: readonly InitHookChoice[] =
        hookIntegration.hook === "none"
          ? ["none"]
          : ["none", hookIntegration.hook];
      const hookLimitations: string[] = [];
      if (options.hook === "auto" && hookIntegration.hook === "raw") {
        try {
          integrations.set(
            "tracked",
            await detectHookIntegration(repositoryRoot, "tracked"),
          );
          selection = "tracked";
          choices = ["none", "tracked", "raw"];
        } catch {
          hookLimitations.push(
            "Tracked setup is unavailable: it needs a root package.json and hook files that can be safely preserved. Local or No remains available.",
          );
        }
      } else if (options.hook === "tracked") {
        integrations.set("tracked", hookIntegration);
        selection = "tracked";
        choices = ["none", "tracked"];
      }
      const proposalForSelection = (
        profile: ProfileId,
        checks: readonly CheckId[] | undefined,
        osvUnavailable: InitOsvUnavailable,
        selectedHook: InitHookChoice = selection,
        selectedFormatting:
          InitFormattingChoice | undefined = options.formatting,
        selectedProjectTrust = false,
        evaluatedImport: InitFormattingImport | undefined = undefined,
      ): InitProposal => {
        const selectedIntegration = integrations.get(selectedHook);
        if (selectedIntegration === undefined)
          throw new Error("Invalid hook selection.");
        // Prompt capability alone never authorizes executable code; only the
        // separately confirmed disclosure (or the explicit CLI flag) does.
        const trustGranted =
          selectedFormatting === "project" &&
          (options.trustProjectPrettier || selectedProjectTrust);
        const formattingFields =
          selectedFormatting === undefined
            ? {
                // Detection stays visible even when no engine choice is made.
                formattingDetection: formattingSetup.detection,
              }
            : {
                formattingDetection: formattingSetup.detection,
                formatting: selectedFormatting,
                ...(selectedFormatting === "copy"
                  ? {
                      formattingImport:
                        evaluatedImport ?? formattingSetup.imported,
                    }
                  : {}),
                ...(selectedFormatting === "project"
                  ? {
                      formattingProjectRoots: enabledProjectRoots,
                      formattingRootProject:
                        formattingSetup.projectRoots.includes("."),
                    }
                  : {}),
                ...(trustGranted
                  ? {
                      projectPrettierTrustRoots: formattingSetup.projectRoots,
                      projectPrettierTrustConfirmed: true,
                    }
                  : {}),
                ...((selectedFormatting === "managed" ||
                  selectedFormatting === "off") &&
                formattingSetup.storedTrustRoots.length > 0
                  ? {
                      projectPrettierRevokeRoots:
                        formattingSetup.storedTrustRoots,
                    }
                  : {}),
                ...(evaluatedImport !== undefined &&
                interactiveEvaluatedConfigs !== undefined
                  ? {
                      executableEvaluatedConfigs: interactiveEvaluatedConfigs,
                    }
                  : {}),
              };
        const selectedProposal = createInitProposal(inspection, {
          repositoryRoot,
          configBefore,
          profile,
          osvUnavailable,
          hook: selectedIntegration.hook,
          hookActivation: selectedIntegration.activation,
          hookChanges: selectedIntegration.changes,
          hooksPathChange: selectedIntegration.hooksPathChange,
          ...formattingFields,
          ...(selectedIntegration.change === undefined
            ? {}
            : { hookChange: selectedIntegration.change }),
          ...(checks === undefined ? {} : { checks }),
        });
        return Object.freeze({
          ...selectedProposal,
          limitations: [...selectedProposal.limitations, ...hookLimitations],
          hookSelection: selectedHook,
          ...(choices.length > 1 ? { hookChoices: choices } : {}),
        });
      };
      proposal = proposalForSelection(
        options.profile,
        options.checks,
        options.osvUnavailable ?? "block",
      );
      const decision = await dependencies.confirm(
        proposal,
        {
          width: io.width,
          color,
          animations: options.animations && io.env.NO_COLOR === undefined,
        },
        proposalForSelection,
        evaluateExecutableImportForUi,
      );
      if (decision !== false) {
        proposal = decision;
        confirmed = true;
      }
    }
    const result = confirmed
      ? await applyInitProposal(proposal)
      : { applied: false, files: [] as readonly string[], rolledBack: false };
    if (options.format === "json") {
      io.writeStdout(
        `${JSON.stringify(
          {
            applied: result.applied,
            files: result.files,
            rolledBack: result.rolledBack,
            proposal: publicProposal(proposal),
          },
          null,
          2,
        )}\n`,
      );
    } else if (promptedInteractively) {
      io.writeStdout(renderInteractiveResult(confirmed, proposal));
    } else {
      io.writeStdout(renderText(proposal, result.applied));
    }
    return 0;
  } catch (error) {
    io.writeStderr(renderInitFailure(error));
    return 2;
  }
}

export function parseCheckSelection(value: string): readonly CheckId[] {
  const requested = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const unknown = requested.filter(
    (item): item is string => !CHECK_IDS.includes(item as CheckId),
  );
  if (requested.length === 0 || unknown.length > 0) {
    throw new Error(
      `Checks must be a comma-separated subset of: ${CHECK_IDS.join(", ")}`,
    );
  }
  const selected = new Set(requested as CheckId[]);
  return Object.freeze(CHECK_IDS.filter((check) => selected.has(check)));
}
