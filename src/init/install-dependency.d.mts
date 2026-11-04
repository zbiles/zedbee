export type InstallManager = "npm" | "pnpm" | "yarn" | "bun";
export interface InstallOptions {
  readonly manager: InstallManager;
  readonly cwd: string;
  readonly packageSpec: string;
  readonly workspaceRoot?: boolean;
  readonly signal?: AbortSignal;
}
export interface InstallExecutionOptions {
  cwd: string;
  env: Record<string, string>;
  cancelSignal: AbortSignal | undefined;
  timeout: number;
  stdin: "ignore";
  reject: false;
  killDescendants?: boolean;
  maxBuffer?: number;
}
export type InstallExecutor = (
  command: string,
  args: readonly string[],
  options: InstallExecutionOptions,
) => Promise<{ exitCode?: number; stdout: string; stderr: string }>;
export function installArguments(
  manager: InstallManager,
  workspaceRoot: boolean,
  classicYarn: boolean,
  packageSpec: string,
): string[];
export function installDependency(
  options: InstallOptions,
  execute?: InstallExecutor,
): Promise<void>;

export function windowsManagerInvocation(
  manager: InstallManager,
  pathValue: string,
): Promise<{ command: string; args: string[] }>;
