import { parse, type ParseError } from "jsonc-parser";
import { configFileSchema, type ResolvedConfig } from "../../config/schema.js";
import { repositoryConfigPath } from "../../config/selection-path.js";
import { readContainedFile } from "../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import type { RepositoryInspection } from "../../inspection/types.js";
import { CheckIncompleteError } from "../incomplete-error.js";

export function deadCodePolicyPath(
  repositoryRoot: string,
  config: ResolvedConfig,
): string {
  if (config.configPath === undefined) return ".zedbeerc.jsonc";
  const path = repositoryConfigPath(repositoryRoot, config.configPath);
  if (path === undefined)
    throw new TypeError(
      "Dead-code configuration must be inside its repository",
    );
  return path;
}
/** Entry roots are graph inputs, so each side uses its own inert policy bytes. */
export async function snapshotEntryPoints(
  inspection: RepositoryInspection,
  config: ResolvedConfig,
  repositoryRoot: string,
  baseline: boolean,
  capture?: (path: string) => void,
): Promise<readonly string[]> {
  const path = deadCodePolicyPath(repositoryRoot, config);
  capture?.(path);
  const registry = await captureSnapshotRegistry(inspection.snapshotRoot, [
    path,
  ]);
  if (!baseline) return config.checks.deadCode.entryPoints ?? [];
  if (registry.resolve(path) === undefined) {
    // Direct adapter callers may supply an in-memory policy without a file.
    return config.configPath === undefined
      ? (config.checks.deadCode.entryPoints ?? [])
      : [];
  }
  try {
    const errors: ParseError[] = [];
    const value: unknown = parse(
      await readContainedFile(registry, path, { maxBytes: 1024 * 1024 }),
      errors,
      { allowTrailingComma: true, disallowComments: false },
    );
    const parsed = configFileSchema.safeParse(value);
    if (errors.length || !parsed.success)
      throw new TypeError("Invalid entry policy");
    const policy = parsed.data.checks?.deadCode;
    return typeof policy === "object" ? (policy.entryPoints ?? []) : [];
  } catch {
    throw new CheckIncompleteError({
      code: "DEAD_CODE_ENTRY_CONFIGURATION_UNSUPPORTED",
      path,
      message:
        "Dead-code baseline entry configuration could not be read safely.",
      remediation:
        "Use valid captured JSONC configuration on both comparison sides so explicit entry changes can be attributed reliably.",
    });
  }
}
