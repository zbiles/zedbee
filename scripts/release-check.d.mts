export type VerificationMode = "verify" | "release";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface VerificationStep {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
}

export function verificationSteps(
  mode?: VerificationMode,
): readonly VerificationStep[];

export function releaseArtifactSteps(): readonly VerificationStep[];

export function packageManagerInstall(
  manager: PackageManager,
  tarball: string,
): Readonly<{ command: string; args: readonly string[] }>;

export function releaseReadiness(
  packageJson: unknown,
  remoteUrls: readonly string[],
): Readonly<{ ready: true }> | Readonly<{ ready: false; message: string }>;

export function runVerification(mode: VerificationMode, cwd?: string): void;
