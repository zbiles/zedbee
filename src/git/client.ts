import { execa } from "execa";
import { GitCommandError } from "./errors.js";

export interface GitRunOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  reject?: boolean;
}

export interface GitOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class GitClient {
  constructor(readonly repositoryRoot: string) {}

  async run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitOutput> {
    if (isAborted(options.signal)) {
      throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
    }

    try {
      const result = await execa("git", args, {
        cwd: options.cwd ?? this.repositoryRoot,
        reject: false,
        shell: false,
        stdin: "ignore",
        forceKillAfterDelay: 2_000,
        ...(options.env === undefined ? {} : { env: { ...options.env } }),
        ...(options.signal === undefined
          ? {}
          : { cancelSignal: options.signal }),
      });

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
      if (isAborted(options.signal)) {
        throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
      }
      throw new GitCommandError(
        "GIT_COMMAND_FAILED",
        "Git command could not be started.",
      );
    }
  }

  tryRun(
    args: readonly string[],
    options: Omit<GitRunOptions, "reject"> = {},
  ): Promise<GitOutput> {
    return this.run(args, { ...options, reject: false });
  }
}
