export const PLUGIN_FILES: readonly string[];
export function claudeManifest(
  manifest: Record<string, any>,
): Record<string, any>;
export function checkPlugin(
  root?: string,
  options?: { write?: boolean },
): Promise<Record<string, any>>;
export function preparePlugin(
  outputDirectory: string,
  root?: string,
): Promise<{ archive: string; version: string; files: string[] }>;
