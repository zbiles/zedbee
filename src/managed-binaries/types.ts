export type ManagedEngine = "gitleaks" | "osv-scanner";
export type ManagedPlatform = "darwin" | "linux" | "win32";
export type ManagedArchitecture = "arm64" | "x64";

export type ManagedBinaryErrorCode =
  | "MANAGED_BINARY_UNAVAILABLE"
  | "MANAGED_BINARY_CHECKSUM_MISMATCH"
  | "MANAGED_BINARY_FAILED"
  | "MANAGED_BINARY_TIMEOUT"
  | "MANAGED_BINARY_ABORTED";

export class ManagedBinaryError extends Error {
  readonly code: ManagedBinaryErrorCode;
  readonly engine: ManagedEngine;
  readonly exitCode?: number;

  constructor(
    code: ManagedBinaryErrorCode,
    engine: ManagedEngine,
    message: string,
    exitCode?: number,
  ) {
    super(message);
    this.name = "ManagedBinaryError";
    this.code = code;
    this.engine = engine;
    if (exitCode !== undefined) this.exitCode = exitCode;
  }
}

export interface ManagedBinary {
  readonly engine: ManagedEngine;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly configPath?: string;
  readonly configSha256?: string;
}

export interface ManagedRunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly acceptedExitCodes?: readonly number[];
}

export interface ManagedRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
