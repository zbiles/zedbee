export interface ReleaseManifest {
  readonly name?: unknown;
  readonly version?: unknown;
}

export function releaseArtifactFilename(
  packOutput: string,
  manifest: ReleaseManifest,
): string;

export function assertReleaseBaseScanReport(
  report: unknown,
  expected: Readonly<{ baseline: string; target: string }>,
): void;

export function prepareReleaseArtifact(cwd?: string): string;
