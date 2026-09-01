import type { GitClient } from "./client.js";
import { isGitObjectId, validateRequestedBase } from "./base-ref.js";

export interface BaseComparison {
  readonly requestedBase: string;
  readonly baselineCommit: string;
  readonly targetCommit: string;
}

export type BaseComparisonErrorCode =
  | "BASE_REF_INVALID"
  | "BASE_REF_UNAVAILABLE"
  | "TARGET_COMMIT_UNAVAILABLE"
  | "MERGE_BASE_UNAVAILABLE"
  | "MERGE_BASE_AMBIGUOUS"
  | "REVISION_OUTPUT_INVALID";

export class BaseComparisonError extends Error {
  readonly code: BaseComparisonErrorCode;

  constructor(code: BaseComparisonErrorCode, message: string) {
    super(message);
    this.name = "BaseComparisonError";
    this.code = code;
  }
}

function fail(code: BaseComparisonErrorCode): never {
  const messages: Record<BaseComparisonErrorCode, string> = {
    BASE_REF_INVALID: "The requested base ref is invalid.",
    BASE_REF_UNAVAILABLE: "The requested base ref is unavailable.",
    TARGET_COMMIT_UNAVAILABLE: "The target commit is unavailable.",
    MERGE_BASE_UNAVAILABLE: "No merge base is available.",
    MERGE_BASE_AMBIGUOUS: "The merge base is ambiguous.",
    REVISION_OUTPUT_INVALID: "Git returned invalid revision output.",
  };
  throw new BaseComparisonError(code, messages[code]);
}

function revision(stdout: string): string {
  const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!isGitObjectId(value)) fail("REVISION_OUTPUT_INVALID");
  return value;
}

function runRevisionCommand(
  git: GitClient,
  args: readonly string[],
  signal: AbortSignal | undefined,
) {
  return git.run(
    args,
    signal === undefined ? { reject: false } : { reject: false, signal },
  );
}

export async function resolveBaseComparison(
  git: GitClient,
  requestedBase: string,
  signal?: AbortSignal,
): Promise<BaseComparison> {
  try {
    requestedBase = validateRequestedBase(requestedBase);
  } catch {
    fail("BASE_REF_INVALID");
  }

  const baseOutput = await runRevisionCommand(
    git,
    ["rev-parse", "--verify", "--end-of-options", `${requestedBase}^{commit}`],
    signal,
  );
  if (baseOutput.exitCode !== 0) fail("BASE_REF_UNAVAILABLE");
  const baseTip = revision(baseOutput.stdout);

  const targetOutput = await runRevisionCommand(
    git,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    signal,
  );
  if (targetOutput.exitCode !== 0) fail("TARGET_COMMIT_UNAVAILABLE");
  const targetCommit = revision(targetOutput.stdout);

  const mergeOutput = await runRevisionCommand(
    git,
    ["merge-base", "--all", baseTip, targetCommit],
    signal,
  );
  if (mergeOutput.exitCode !== 0) fail("MERGE_BASE_UNAVAILABLE");
  const mergeBases = mergeOutput.stdout
    .split("\n")
    .filter((line) => line.length > 0);
  if (mergeBases.length === 0) fail("MERGE_BASE_UNAVAILABLE");
  if (mergeBases.some((line) => !isGitObjectId(line))) {
    fail("REVISION_OUTPUT_INVALID");
  }
  if (mergeBases.length > 1) fail("MERGE_BASE_AMBIGUOUS");

  return {
    requestedBase,
    baselineCommit: mergeBases[0]!,
    targetCommit,
  };
}
