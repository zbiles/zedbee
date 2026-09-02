import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execa } from "execa";
import {
  consumeGitBatchBlobOutput,
  type GitBlobVisitor,
} from "./batch-object-stream.js";
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

export interface GitBinaryOutput {
  stdout: Buffer;
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

interface ResolvedGitCommand {
  readonly executable: string;
  readonly path: string;
}

function pathValue(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const entry = Object.entries(environment).find(
    ([key]) => key.toLowerCase() === "path",
  );
  return entry?.[1] ?? "";
}

function containsNodeModulesBin(path: string): boolean {
  const components = path
    .split(/[\\/]+/u)
    .filter((component) => component !== "")
    .map((component) => component.toLowerCase());
  return components.some(
    (component, index) =>
      component === "node_modules" && components[index + 1] === ".bin",
  );
}

function isContainedPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`))
  );
}

function executableNames(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  if (process.platform !== "win32") return ["git"];
  const configured = Object.entries(environment).find(
    ([key]) => key.toLowerCase() === "pathext",
  )?.[1];
  const extensions = (configured ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension !== "")
    .map((extension) => extension.toLowerCase());
  return [...new Set(extensions)].map((extension) => `git${extension}`);
}

async function canonicalDirectory(path: string): Promise<string | undefined> {
  if (path === "" || !isAbsolute(path) || containsNodeModulesBin(path)) {
    return undefined;
  }
  try {
    const canonical = await realpath(path);
    return containsNodeModulesBin(canonical) ? undefined : canonical;
  } catch {
    return undefined;
  }
}

async function repositoryTrustRoot(path: string): Promise<string> {
  const start = await realpath(resolve(path));
  let current = start;
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return start;
      current = parent;
    }
  }
}

async function resolveGitCommand(
  repositoryRoot: string,
): Promise<ResolvedGitCommand> {
  const canonicalRoot = await repositoryTrustRoot(repositoryRoot);
  const safeDirectories: string[] = [];
  for (const entry of pathValue(process.env).split(delimiter)) {
    const directory = await canonicalDirectory(entry);
    if (
      directory === undefined ||
      isContainedPath(canonicalRoot, directory) ||
      safeDirectories.includes(directory)
    ) {
      continue;
    }
    safeDirectories.push(directory);
  }

  for (const directory of safeDirectories) {
    for (const name of executableNames(process.env)) {
      const candidate = join(directory, name);
      try {
        const canonical = await realpath(candidate);
        const metadata = await stat(canonical);
        if (
          !metadata.isFile() ||
          containsNodeModulesBin(canonical) ||
          isContainedPath(canonicalRoot, canonical)
        ) {
          continue;
        }
        await access(
          canonical,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return { executable: canonical, path: safeDirectories.join(delimiter) };
      } catch {
        // Continue to the next trusted PATH candidate.
      }
    }
  }
  throw new Error("No trusted Git executable is available.");
}

function commandEnvironment(
  safePath: string,
  overrides: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(overrides ?? {}),
  };
  for (const key of Object.keys(environment)) {
    if (
      key.toLowerCase() === "path" ||
      key.toLowerCase() === "git_no_lazy_fetch"
    ) {
      delete environment[key];
    }
  }
  environment.PATH = safePath;
  environment.GIT_NO_LAZY_FETCH = "1";
  return environment;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isOutputLimitExceeded(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "isMaxBuffer" in error &&
    error.isMaxBuffer === true
  );
}

const DEFAULT_DIAGNOSTIC_LIMIT_BYTES = 100_000_000;

async function* batchObjectInput(
  objectIds: readonly string[],
): AsyncIterable<Buffer> {
  for (const objectId of objectIds) {
    yield Buffer.from(`${objectId}\n`, "ascii");
  }
}

async function drainDiagnosticStream(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
  exceeded: () => void,
): Promise<void> {
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > limit) {
      exceeded();
      throw new Error("Git diagnostic output exceeded its configured limit.");
    }
  }
}

export class GitClient {
  private gitCommand: Promise<ResolvedGitCommand> | undefined;

  constructor(
    readonly repositoryRoot: string,
    private readonly clientOptions: GitClientOptions = {},
  ) {}

  private resolvedGitCommand(): Promise<ResolvedGitCommand> {
    this.gitCommand ??= resolveGitCommand(this.repositoryRoot);
    return this.gitCommand;
  }

  private async execute(
    args: readonly string[],
    options: GitRunOptions,
    binary: boolean,
  ): Promise<GitOutput | GitBinaryOutput> {
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
        : setTimeout(
            () => this.clientOptions.onSoftTimeout?.(),
            resourcePolicy.gitSoftTimeoutMs,
          );
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
        return binary
          ? { ...output, stdout: Buffer.from(output.stdout, "utf8") }
          : output;
      }
      const command = await this.resolvedGitCommand();
      const commandOptions = {
        cwd: options.cwd ?? this.repositoryRoot,
        reject: false,
        shell: false,
        stdin: "ignore",
        forceKillAfterDelay: 2_000,
        extendEnv: false,
        env: commandEnvironment(command.path, options.env),
        ...(maxOutputBytes === undefined ? {} : { maxBuffer: maxOutputBytes }),
        cancelSignal: signal,
      } as const;
      const result = binary
        ? await execa(command.executable, args, {
            ...commandOptions,
            encoding: "buffer",
            stripFinalNewline: false,
          })
        : await execa(command.executable, args, commandOptions);

      if (isOutputLimitExceeded(result)) {
        throw new GitCommandError(
          "GIT_OUTPUT_LIMIT_EXCEEDED",
          "Git command exceeded its configured output limit.",
        );
      }
      if (hardTimedOut) {
        throw new GitCommandError(
          "GIT_HARD_TIMEOUT",
          "Git command exceeded its configured hard timeout.",
        );
      }
      if (result.isCanceled || isAborted(options.signal)) {
        throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
      }

      const stderr =
        typeof result.stderr === "string"
          ? result.stderr
          : Buffer.from(result.stderr).toString("utf8");
      const output: GitOutput | GitBinaryOutput = binary
        ? {
            stdout: Buffer.from(result.stdout as Uint8Array),
            stderr,
            exitCode: result.exitCode ?? -1,
          }
        : {
            stdout: result.stdout as string,
            stderr,
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
      if (isOutputLimitExceeded(error)) {
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

  run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitOutput> {
    return this.execute(args, options, false) as Promise<GitOutput>;
  }

  runBytes(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitBinaryOutput> {
    return this.execute(args, options, true) as Promise<GitBinaryOutput>;
  }

  async streamBlobs(
    objectIds: readonly string[],
    visit: GitBlobVisitor,
    options: GitRunOptions = {},
  ): Promise<void> {
    if (isAborted(options.signal)) {
      throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
    }
    if (objectIds.length === 0) return;

    const command = await this.resolvedGitCommand();
    if (isAborted(options.signal)) {
      throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
    }
    const resourcePolicy = this.clientOptions.resourcePolicy;
    const diagnosticLimit =
      options.maxOutputBytes ??
      resourcePolicy?.gitOutputLimitBytes ??
      DEFAULT_DIAGNOSTIC_LIMIT_BYTES;
    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([options.signal, controller.signal]);
    let hardTimedOut = false;
    let diagnosticLimitExceeded = false;
    let visitorFailed = false;
    let visitorFailure: unknown;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const child = spawn(command.executable, ["cat-file", "--batch"], {
      cwd: options.cwd ?? this.repositoryRoot,
      env: commandEnvironment(command.path, options.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const terminate = () => {
      // Do not wait for process shutdown to close the pipes. A failed blob
      // visitor can stop reading stdout while Git is still writing, and under
      // load that can otherwise leave one of the stream promises pending.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const abort = () => terminate();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) terminate();
    const softTimer =
      resourcePolicy?.gitSoftTimeoutMs === undefined
        ? undefined
        : setTimeout(
            () => this.clientOptions.onSoftTimeout?.(),
            resourcePolicy.gitSoftTimeoutMs,
          );
    const hardTimer =
      resourcePolicy?.gitHardTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            hardTimedOut = true;
            controller.abort();
          }, resourcePolicy.gitHardTimeoutMs);
    const exit = new Promise<number>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code) => resolveExit(code ?? -1));
    });
    const input = pipeline(
      Readable.from(batchObjectInput(objectIds), { objectMode: false }),
      child.stdin,
    );
    const output = consumeGitBatchBlobOutput(
      child.stdout,
      objectIds,
      async (blob) => {
        try {
          await visit(blob);
        } catch (error) {
          visitorFailed = true;
          visitorFailure = error;
          throw error;
        }
      },
    );
    const diagnostics = drainDiagnosticStream(
      child.stderr,
      diagnosticLimit,
      () => {
        diagnosticLimitExceeded = true;
        terminate();
      },
    );

    try {
      const [, , , exitCode] = await Promise.all([
        input,
        output,
        diagnostics,
        exit,
      ]);
      if (hardTimedOut) {
        throw new GitCommandError(
          "GIT_HARD_TIMEOUT",
          "Git command exceeded its configured hard timeout.",
        );
      }
      if (isAborted(options.signal)) {
        throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
      }
      if (diagnosticLimitExceeded) {
        throw new GitCommandError(
          "GIT_OUTPUT_LIMIT_EXCEEDED",
          "Git command exceeded its configured output limit.",
        );
      }
      if (exitCode !== 0) {
        throw new GitCommandError(
          "GIT_COMMAND_FAILED",
          `Git command failed with exit code ${exitCode}.`,
          exitCode,
        );
      }
    } catch (error) {
      terminate();
      await Promise.allSettled([input, output, diagnostics, exit]);
      if (hardTimedOut) {
        throw new GitCommandError(
          "GIT_HARD_TIMEOUT",
          "Git command exceeded its configured hard timeout.",
        );
      }
      if (diagnosticLimitExceeded) {
        throw new GitCommandError(
          "GIT_OUTPUT_LIMIT_EXCEEDED",
          "Git command exceeded its configured output limit.",
        );
      }
      if (isAborted(options.signal)) {
        throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
      }
      if (visitorFailed) throw visitorFailure;
      if (error instanceof GitCommandError) throw error;
      throw new GitCommandError(
        "GIT_COMMAND_FAILED",
        "Git command could not be completed.",
      );
    } finally {
      signal.removeEventListener("abort", abort);
      if (softTimer !== undefined) clearTimeout(softTimer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    }
  }

  tryRun(
    args: readonly string[],
    options: Omit<GitRunOptions, "reject"> = {},
  ): Promise<GitOutput> {
    return this.run(args, { ...options, reject: false });
  }
}
