export type GitErrorCode =
  | "GIT_ABORTED"
  | "GIT_COMMAND_FAILED"
  | "GIT_HARD_TIMEOUT"
  | "GIT_OUTPUT_LIMIT_EXCEEDED";

export class GitCommandError extends Error {
  readonly code: GitErrorCode;
  readonly exitCode: number | undefined;

  constructor(code: GitErrorCode, message: string, exitCode?: number) {
    super(message);
    this.name = "GitCommandError";
    this.code = code;
    this.exitCode = exitCode;
  }
}
