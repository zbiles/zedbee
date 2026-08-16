import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GitClient } from "../git/client.js";
import { detectHookIntegration } from "../hooks/detect.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import type { RepositoryInspection } from "../inspection/types.js";
import { createInitProposal } from "../init/recommend.js";
import type {
  CreateInitProposalOptions,
  InitHookChoice,
  InitProposal,
} from "../init/types.js";
import { applyInitProposal } from "../init/write-config.js";
import { CHECK_IDS, type CheckId, type ProfileId } from "../config/schema.js";

export interface InitCommandOptions {
  readonly cwd: string;
  readonly profile: ProfileId;
  readonly hook: InitHookChoice;
  readonly checks?: readonly CheckId[];
  readonly yes: boolean;
  readonly format: "text" | "json";
  readonly color: boolean;
  readonly animations: boolean;
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
}

export interface InitCommandDependencies {
  resolveRepositoryRoot(cwd: string): Promise<string>;
  inspect(repositoryRoot: string): Promise<RepositoryInspection>;
  confirm(
    proposal: InitProposal,
    options: InitPromptOptions,
    proposalForChecks: (checks: readonly CheckId[]) => InitProposal,
  ): Promise<false | InitProposal>;
}

const DEFAULT_DEPENDENCIES: InitCommandDependencies = {
  async resolveRepositoryRoot(cwd) {
    return (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"]))
      .stdout;
  },
  inspect: inspectRepository,
  async confirm(proposal, options, proposalForChecks) {
    const { runInitPrompt } = await import("../ui/init-app.js");
    return runInitPrompt(proposal, options, proposalForChecks);
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
    detectedEnvironments: proposal.detectedEnvironments,
    recommendedChecks: proposal.recommendedChecks,
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
  if (!applied) lines.push("", "No files were written without confirmation.");
  return `${lines.join("\n")}\n`;
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
    const [inspection, hookIntegration, configBefore] = await Promise.all([
      dependencies.inspect(repositoryRoot),
      detectHookIntegration(repositoryRoot, options.hook),
      existingConfig(repositoryRoot),
    ]);
    const proposalOptions: CreateInitProposalOptions = {
      repositoryRoot,
      profile: options.profile,
      hook: hookIntegration.hook,
      ...(options.checks === undefined ? {} : { checks: options.checks }),
      configBefore,
      ...(hookIntegration.change === undefined
        ? {}
        : { hookChange: hookIntegration.change }),
      hookActivation: hookIntegration.activation,
    };
    let proposal = createInitProposal(inspection, proposalOptions);
    const color = options.color && io.env.NO_COLOR === undefined;
    let confirmed = options.yes;
    if (
      !confirmed &&
      options.format === "text" &&
      io.stdinIsTTY &&
      io.stdoutIsTTY
    ) {
      const decision = await dependencies.confirm(
        proposal,
        {
          width: io.width,
          color,
          animations: options.animations && io.env.NO_COLOR === undefined,
        },
        (checks) =>
          createInitProposal(inspection, {
            ...proposalOptions,
            checks,
          }),
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
    } else {
      io.writeStdout(renderText(proposal, result.applied));
    }
    return 0;
  } catch {
    io.writeStderr("Zedbee could not initialize this repository safely.\n");
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
