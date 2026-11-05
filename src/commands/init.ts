import {
  resolveFormattingSetup,
  evaluateExecutableProjectConfigs,
  ProjectPrettierTrustRequiredError,
} from "../init/formatter-setup.js";
import {
  publicProposal,
  renderText,
  renderInitFailure,
  renderInteractiveResult,
} from "../init/presentation.js";
import {
  buildInitSelectionOptions,
  type InitSelection,
  type InitSelectionContext,
} from "../init/selection-policy.js";
import type { EvaluatedExecutableImports } from "../init/types.js";
import {
  HookInstallationError,
  resolveHookCommand,
  resolveLocalSchemaReference,
} from "../hooks/command.js";
import { captureWorkingTreeRegistry } from "../inspection/working-tree-registry.js";
import {
  installProjectDependency,
  projectInstallTargets,
  type ProjectInstallTarget,
} from "../init/install-project.js";
import { TelemetryStore, telemetryDirectory } from "../telemetry/state.js";
import {
  telemetryDisabled,
  type TelemetryEnvironment,
} from "../telemetry/policy.js";
import type { TelemetrySummary } from "../telemetry/client.js";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GitClient } from "../git/client.js";
import {
  detectHookIntegration,
  type DetectedHookIntegration,
} from "../hooks/detect.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import type { RepositoryInspection } from "../inspection/types.js";
import { parse as parseJsonc } from "jsonc-parser";
import {
  GithubWorkflowSetupError,
  prepareGithubWorkflow,
} from "../init/github-workflow.js";
import { formatInitProposal } from "../init/format-proposal.js";
import { createInitProposal } from "../init/recommend.js";
import type {
  InitFormattingChoice,
  InitFormattingScope,
  InitHookChoice,
  InitWorkflowChoice,
  InitOsvUnavailable,
  InitProposal,
} from "../init/types.js";
import { applyInitProposal } from "../init/write-config.js";
import { CHECK_IDS, type CheckId, type ProfileId } from "../config/schema.js";

export interface InitCommandOptions {
  readonly telemetrySummary?: (value: TelemetrySummary) => void;
  readonly cwd: string;
  readonly profile: ProfileId;
  readonly hook: InitHookChoice;
  readonly checks?: readonly CheckId[];
  readonly workflow?: InitWorkflowChoice;
  readonly osvUnavailable?: InitOsvUnavailable;
  readonly formatting?: InitFormattingChoice;
  readonly formattingScope?: InitFormattingScope;
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
  readonly projectPrettierTrustStored?: boolean;
  readonly width: number;
  readonly color: boolean;
  readonly animations: boolean;
  /** Deterministic render seam for tests; production resolves Ink's live size. */
  readonly terminalSize?: Readonly<{ columns: number; rows: number }>;
}

export interface InitCommandDependencies {
  installProject?(
    repositoryRoot: string,
    targets: readonly ProjectInstallTarget[],
    options: InitPromptOptions & { readonly signal?: AbortSignal },
  ): Promise<boolean>;
  resolveHookCommand?(repositoryRoot: string): Promise<string>;
  readTelemetryPreference?(env: TelemetryEnvironment): boolean;
  saveTelemetryPreference?(env: TelemetryEnvironment, enabled: boolean): void;
  resolveRepositoryRoot(cwd: string): Promise<string>;
  inspect(repositoryRoot: string): Promise<RepositoryInspection>;
  confirm(
    proposal: InitProposal,
    options: InitPromptOptions,
    proposalForSelection: (selection: InitSelection) => InitProposal,
    evaluateExecutableImport?: (
      signal: AbortSignal,
    ) => Promise<EvaluatedExecutableImports | undefined>,
    prepareReview?: (proposal: InitProposal) => Promise<InitProposal>,
  ): Promise<false | InitProposal>;
}

const DEFAULT_DEPENDENCIES: InitCommandDependencies = {
  async installProject(repositoryRoot, targets, options) {
    const { runProjectInstallPrompt } =
      await import("../ui/install-project-app.js");
    return runProjectInstallPrompt(targets, options, (target, signal) =>
      installProjectDependency(repositoryRoot, target, signal),
    );
  },
  readTelemetryPreference(env) {
    return (
      new TelemetryStore(telemetryDirectory(env)).read()?.enabled !== false
    );
  },
  saveTelemetryPreference(env, enabled) {
    new TelemetryStore(telemetryDirectory(env)).setEnabled(enabled);
  },
  async resolveRepositoryRoot(cwd) {
    return (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"]))
      .stdout;
  },
  inspect: async (root) =>
    inspectRepository(root, {
      registry: await captureWorkingTreeRegistry(root),
    }),
  async confirm(
    proposal,
    options,
    proposalForSelection,
    evaluateExecutableImport,
    prepareReview,
  ) {
    const { runInitPrompt } = await import("../ui/init-app.js");
    return runInitPrompt(
      proposal,
      options,
      proposalForSelection,
      evaluateExecutableImport,
      prepareReview,
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
    const resolveCommand =
      dependencies.resolveHookCommand ?? resolveHookCommand;
    let hookCommand: string | undefined;
    if (options.hook !== "none") {
      try {
        hookCommand = await resolveCommand(repositoryRoot);
      } catch (error) {
        if (
          !canPrompt ||
          !(error instanceof HookInstallationError) ||
          error.projectRoots.length === 0
        )
          throw error;
        const targets = await projectInstallTargets(
          repositoryRoot,
          error.projectRoots,
        );
        if (targets.length === 0) throw error;
        const installed = await (
          dependencies.installProject ?? DEFAULT_DEPENDENCIES.installProject!
        )(repositoryRoot, targets, {
          width: io.width,
          color: options.color && io.env.NO_COLOR === undefined,
          animations: options.animations,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (!installed) {
          io.writeStdout("Zedbee initialization cancelled.\n");
          return 0;
        }
        hookCommand = await resolveCommand(repositoryRoot);
      }
    }
    const [inspection, hookIntegration, configBefore, schemaReference] =
      await Promise.all([
        dependencies.inspect(repositoryRoot),
        detectHookIntegration(repositoryRoot, options.hook, hookCommand),
        existingConfig(repositoryRoot),
        resolveLocalSchemaReference(repositoryRoot),
      ]);
    const workflowPreparation =
      canPrompt || options.workflow === "github"
        ? await prepareGithubWorkflow(repositoryRoot, inspection)
        : undefined;
    if (
      options.workflow === "github" &&
      (workflowPreparation?.status === "unsafe" ||
        workflowPreparation?.status === "unsupported")
    )
      throw new GithubWorkflowSetupError(
        workflowPreparation?.message ?? "GitHub workflow setup is unavailable.",
      );
    const formattingSetup = await resolveFormattingSetup(repositoryRoot);
    const allProjectsTrusted =
      formattingSetup.projectRoots.length > 0 &&
      formattingSetup.projectRoots.every((root) =>
        formattingSetup.storedTrustRoots.includes(root),
      );
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
    const executableTargets = formattingSetup.executableTargets;
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
    const evaluateExecutableImportForUi =
      canPrompt && executableTargets.length > 0
        ? (signal: AbortSignal) =>
            evaluateExecutableProjectConfigs(
              repositoryRoot,
              formattingSetup.imported,
              executableTargets,
              options.signal === undefined
                ? signal
                : AbortSignal.any([signal, options.signal]),
            )
        : undefined;
    const effectiveCopyImport =
      evaluatedExecutableImports?.imported ?? formattingSetup.imported;
    if (
      options.formatting === "copy" &&
      !canPrompt &&
      effectiveCopyImport.limitations.length > 0
    ) {
      throw new Error(
        "The settings copy has unresolved limitations and cannot be applied noninteractively.",
      );
    }
    const formattingScopeRoots = formattingSetup.projectRoots;
    const formattingScope: InitFormattingScope =
      options.formattingScope ??
      (configBefore !== null
        ? (
            parseJsonc(configBefore).overrides as
              Array<{ generated?: string }> | undefined
          )?.some((entry) => entry.generated === "prettier-scope")
          ? "projects"
          : "repository"
        : undefined) ??
      (formattingScopeRoots.length > 0 && !formattingScopeRoots.includes(".")
        ? "projects"
        : "repository");
    const workflowProposalFields = {
      workflow: options.workflow ?? ("none" as InitWorkflowChoice),
      workflowAvailable: workflowPreparation?.status === "available",
      ...(workflowPreparation?.message === undefined
        ? {}
        : { workflowMessage: workflowPreparation.message }),
      ...(workflowPreparation?.change === undefined
        ? {}
        : { workflowChange: workflowPreparation.change }),
    };
    const proposalBaseOptions = {
      repositoryRoot,
      ...workflowProposalFields,
      ...(schemaReference === undefined ? {} : { schemaReference }),
      configBefore,
    };
    const initialSelection: InitSelection = {
      profile: options.profile,
      checks: options.checks,
      osvUnavailable: options.osvUnavailable,
      formatting: options.formatting,
      projectTrust: allProjectsTrusted,
      evaluatedImport: evaluatedExecutableImports,
      workflow: options.workflow,
    };
    const selectionContext: InitSelectionContext = {
      base: proposalBaseOptions,
      defaults: {
        ...initialSelection,
        hook: hookIntegration.hook,
        scope: formattingScope,
      },
      integrations: new Map([[hookIntegration.hook, hookIntegration]]),
      formatting: formattingSetup,
      invocationTrust: options.trustProjectPrettier === true,
    };
    let proposal = await formatInitProposal(
      createInitProposal(
        inspection,
        buildInitSelectionOptions(selectionContext, initialSelection),
      ),
    );
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
      const telemetryDisabledByEnvironment = telemetryDisabled(io.env);
      const telemetryEnabled =
        !telemetryDisabledByEnvironment &&
        (dependencies.readTelemetryPreference?.(io.env) ?? true);
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
            await detectHookIntegration(repositoryRoot, "tracked", hookCommand),
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
      const interactiveContext: InitSelectionContext = {
        ...selectionContext,
        defaults: { ...selectionContext.defaults, hook: selection },
        integrations,
      };
      const proposalForSelection = (selected: InitSelection): InitProposal => {
        const selectedProposal = createInitProposal(
          inspection,
          buildInitSelectionOptions(interactiveContext, selected),
        );
        return Object.freeze({
          ...selectedProposal,
          telemetryEnabled,
          telemetryDisabledByEnvironment,
          limitations: [...selectedProposal.limitations, ...hookLimitations],
          hookSelection: selected.hook ?? selection,
          ...(choices.length > 1 ? { hookChoices: choices } : {}),
        });
      };
      proposal = await formatInitProposal(
        proposalForSelection(initialSelection),
      );
      const decision = await dependencies.confirm(
        proposal,
        {
          width: io.width,
          ...(allProjectsTrusted ? { projectPrettierTrustStored: true } : {}),
          color,
          animations: options.animations && io.env.NO_COLOR === undefined,
        },
        proposalForSelection,
        evaluateExecutableImportForUi,
        formatInitProposal,
      );
      if (decision !== false) {
        proposal = await formatInitProposal(decision);
        confirmed = true;
      }
    }
    const result = confirmed
      ? await applyInitProposal(proposal)
      : { applied: false, files: [] as readonly string[], rolledBack: false };
    if (
      result.applied &&
      promptedInteractively &&
      proposal.telemetryEnabled !== undefined &&
      !telemetryDisabled(io.env)
    ) {
      dependencies.saveTelemetryPreference?.(io.env, proposal.telemetryEnabled);
    }
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
    try {
      options.telemetrySummary?.({
        outcome: result.applied
          ? "completed"
          : promptedInteractively
            ? "cancelled"
            : "preview",
        profile: proposal.profile,
        hook: proposal.hook,
        check_ids: [...proposal.recommendedChecks],
      });
    } catch {
      /* Metadata observers cannot change setup. */
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
