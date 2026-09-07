export function superviseRun(
  nodeArguments: readonly string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    stdio?: "inherit" | "pipe";
    cancelSignal?: AbortSignal;
  },
): Promise<{ exitCode: number; timedOut: boolean }>;
