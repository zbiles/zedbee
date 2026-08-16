export type GitErrorCode = "GIT_ABORTED" | "GIT_COMMAND_FAILED";

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
