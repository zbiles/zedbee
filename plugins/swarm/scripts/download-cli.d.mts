export const MAX_RELEASE_BYTES: number;
export interface CliRelease {
  version: string;
  url: string;
  sha256: string;
}
export function downloadCli(options?: {
  fetchRelease?: (
    url: string,
    options: { signal: AbortSignal },
  ) => Promise<Response>;
  release?: CliRelease;
  temporaryRoot?: string;
}): Promise<{
  version: string;
  url: string;
  integrity: string;
  tarball: string;
  directory: string;
}>;
