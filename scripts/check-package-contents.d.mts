export interface PackageBoundaryOptions {
  readonly sourcePaths: readonly string[];
  readonly reviewedOverridePaths: readonly string[];
}

export const REQUIRED_PACKAGE_FILES: readonly string[];

export function assertRequiredPackageFiles(paths: readonly string[]): void;

export function assertAllowedPackageFiles(
  paths: readonly string[],
  options: PackageBoundaryOptions,
): void;

export function assertPackMetadata(
  packOutput: string,
  expectedVersion: string,
): void;

export function packageFilePaths(packOutput: string): readonly string[];
