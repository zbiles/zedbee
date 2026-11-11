export const hookAssetFiles: readonly string[];
export function replaceAnalysis(
  input: string,
  analysis: string,
  expectedInput: string,
  expectedRegion: string,
): string;
export function generateManagedHooks(root: string, write?: boolean): unknown;
export function copyManagedHooks(root: string): void;
