import semver from "semver";

export const SUPPORTED_PROJECT_PRETTIER_RANGE = ">=3.0.0 <4.0.0";

export interface ManifestDeclaration {
  readonly range: string;
  readonly section: string;
}

export function manifestPrettierDeclaration(
  value: unknown,
): ManifestDeclaration | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = (value as Record<string, unknown>)[section];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    const specifier = (dependencies as Record<string, unknown>).prettier;
    if (typeof specifier === "string") {
      return { range: specifier, section };
    }
  }
  return undefined;
}

export function isSupportedProjectPrettierVersion(version: string): boolean {
  const normalized = semver.valid(version);
  return (
    normalized !== null &&
    semver.satisfies(normalized, SUPPORTED_PROJECT_PRETTIER_RANGE)
  );
}

/**
 * An installed version is accepted only when it satisfies the supported
 * engine range and, when the project declares a semver range, that exact
 * declaration. Non-semver declarations (URLs, tags, `workspace:*`) do not
 * restrict the installed version here; the engine revalidates against the
 * selected snapshot before executing anything.
 */
export function isProjectPrettierVersionAccepted(
  version: string,
  declaredRange: string | undefined,
): boolean {
  if (!isSupportedProjectPrettierVersion(version)) return false;
  if (declaredRange === undefined) return true;
  const normalizedRange = semver.validRange(declaredRange);
  if (normalizedRange === null) return true;
  try {
    return semver.satisfies(semver.valid(version)!, normalizedRange);
  } catch {
    return false;
  }
}
