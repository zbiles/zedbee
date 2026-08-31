import { execa } from "execa";
import { GitCommandError } from "./errors.js";
import type { ScanResourcePolicy } from "../scan/resource-policy.js";

export interface GitRunOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  reject?: boolean;
  maxOutputBytes?: number;
}

export interface GitOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitClientOptions {
  resourcePolicy?: ScanResourcePolicy;
  onSoftTimeout?: () => void;
  runCommand?: (
    args: readonly string[],
    options: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<GitOutput>;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class GitClient {
  constructor(
    readonly repositoryRoot: string,
    private readonly clientOptions: GitClientOptions = {},
  ) {}

  async run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitOutput> {
    if (isAborted(options.signal)) {
      throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
    }

    const resourcePolicy = this.clientOptions.resourcePolicy;
    const maxOutputBytes =
      options.maxOutputBytes ?? resourcePolicy?.gitOutputLimitBytes;
    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([options.signal, controller.signal]);
    let hardTimedOut = false;
    const softTimer =
      resourcePolicy?.gitSoftTimeoutMs === undefined
        ? undefined
        : setTimeout(() => this.clientOptions.onSoftTimeout?.(), resourcePolicy.gitSoftTimeoutMs);
    const hardTimer =
      resourcePolicy?.gitHardTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            hardTimedOut = true;
            controller.abort();
          }, resourcePolicy.gitHardTimeoutMs);

    try {
      if (this.clientOptions.runCommand !== undefined) {
        const output = await this.clientOptions.runCommand(args, { signal });
        if (hardTimedOut) {
          throw new GitCommandError(
            "GIT_HARD_TIMEOUT",
            "Git command exceeded its configured hard timeout.",
          );
        }
        if ((options.reject ?? true) && output.exitCode !== 0) {
          throw new GitCommandError(
            "GIT_COMMAND_FAILED",
            `Git command failed with exit code ${output.exitCode}.`,
            output.exitCode,
          );
        }
        return output;
      }
      const result = await execa("git", args, {
        cwd: options.cwd ?? this.repositoryRoot,
        reject: false,
        shell: false,
        stdin: "ignore",
        forceKillAfterDelay: 2_000,
        ...(maxOutputBytes === undefined ? {} : { maxBuffer: maxOutputBytes }),
        ...(options.env === undefined ? {} : { env: { ...options.env } }),
        cancelSignal: signal,
      });

      if (hardTimedOut) {
        throw new GitCommandError(
          "GIT_HARD_TIMEOUT",
          "Git command exceeded its configured hard timeout.",
        );
      }
      if (result.isCanceled || isAborted(options.signal)) {
        throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
      }

      const output: GitOutput = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? -1,
      };

      if ((options.reject ?? true) && output.exitCode !== 0) {
        throw new GitCommandError(
          "GIT_COMMAND_FAILED",
          `Git command failed with exit code ${output.exitCode}.`,
          output.exitCode,
        );
      }

      return output;
    } catch (error) {
      if (error instanceof GitCommandError) {
        throw error;
      }
      if (hardTimedOut) {
        throw new GitCommandError(
          "GIT_HARD_TIMEOUT",
          "Git command exceeded its configured hard timeout.",
        );
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "isMaxBuffer" in error &&
        error.isMaxBuffer === true
      ) {
        throw new GitCommandError(
          "GIT_OUTPUT_LIMIT_EXCEEDED",
          "Git command exceeded its configured output limit.",
        );
      }
      if (isAborted(options.signal)) {
        throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
      }
      throw new GitCommandError(
        "GIT_COMMAND_FAILED",
        "Git command could not be started.",
      );
    } finally {
      if (softTimer !== undefined) clearTimeout(softTimer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
    }
  }

  tryRun(
    args: readonly string[],
    options: Omit<GitRunOptions, "reject"> = {},
  ): Promise<GitOutput> {
    return this.run(args, { ...options, reject: false });
  }
}
