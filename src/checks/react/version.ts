import { minVersion, satisfies, valid, validRange } from "semver";
import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";
import type {
  DependencyDeclaration,
  DependencySection,
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import { LockfileInventoryError } from "../vulnerabilities/inventory/errors.js";
import { parseLockfileInventory } from "../vulnerabilities/inventory/parse-lockfile.js";
import type { DependencyRecord } from "../vulnerabilities/inventory/types.js";

export const MANAGED_REACT_VERSION = "19.2.0";

export type ReactVersionSource = "lockfile" | "manifest" | "fallback";

export interface ReactVersionResolution {
  readonly version: string;
  readonly source: ReactVersionSource;
}

const REACT_SECTION_PRECEDENCE = [
  "dependencies",
  "optionalDependencies",
  "devDependencies",
  "peerDependencies",
] as const satisfies readonly DependencySection[];

interface ManifestResolution {
  readonly resolution: ReactVersionResolution;
  readonly range?: string;
}

const FALLBACK_RESOLUTION: ReactVersionResolution = Object.freeze({
  version: MANAGED_REACT_VERSION,
  source: "fallback",
});

function selectedReactDeclaration(
  declarations: readonly DependencyDeclaration[],
): DependencyDeclaration | undefined {
  for (const section of REACT_SECTION_PRECEDENCE) {
    const matches = declarations.filter(
      (declaration) =>
        declaration.name === "react" && declaration.section === section,
    );
    if (matches.length > 0) {
      return matches.length === 1 ? matches[0] : undefined;
    }
  }
  return undefined;
}

function resolveManifestVersion(
  workspace: WorkspaceInspection,
): ManifestResolution {
  const declaration = selectedReactDeclaration(
    workspace.dependencyDeclarations,
  );
  if (declaration === undefined) {
    return { resolution: FALLBACK_RESOLUTION };
  }

  const exactVersion = valid(declaration.specifier);
  if (exactVersion !== null) {
    return {
      resolution: { version: exactVersion, source: "manifest" },
      range: exactVersion,
    };
  }

  const range = validRange(declaration.specifier);
  if (range === null) {
    return { resolution: FALLBACK_RESOLUTION };
  }
  const minimum = minVersion(range);
  if (minimum === null || minimum.prerelease.length > 0) {
    return { resolution: FALLBACK_RESOLUTION };
  }
  return {
    resolution: { version: minimum.version, source: "manifest" },
    range,
  };
}

function normalizedImporter(importer: string | undefined): string | undefined {
  if (importer === undefined) return undefined;
  if (importer === ".") return ".";
  try {
    return normalizeRepositoryRelativePath(importer);
  } catch {
    return undefined;
  }
}

function uniqueLockedVersion(
  records: readonly DependencyRecord[],
): string | undefined {
  const versions = new Set(records.map(({ version }) => valid(version)));
  versions.delete(null);
  return versions.size === 1 ? ([...versions][0] ?? undefined) : undefined;
}

export async function resolveReactVersion(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
): Promise<ReactVersionResolution> {
  const manifest = resolveManifestVersion(workspace);
  if (manifest.range === undefined) return manifest.resolution;

  const directRecords: DependencyRecord[] = [];
  try {
    for (const lockfile of inspection.lockfiles) {
      const inventory = await parseLockfileInventory(inspection, lockfile);
      directRecords.push(
        ...inventory.filter(({ dependencyPath, name, version }) => {
          const exactVersion = valid(version);
          return (
            name === "react" &&
            dependencyPath?.length === 1 &&
            dependencyPath[0] === "react" &&
            exactVersion !== null &&
            satisfies(exactVersion, manifest.range ?? "")
          );
        }),
      );
    }
  } catch (error) {
    if (error instanceof LockfileInventoryError) return manifest.resolution;
    throw error;
  }

  const workspaceRoot =
    workspace.relativeRoot === "."
      ? "."
      : normalizeRepositoryRelativePath(workspace.relativeRoot);
  const importerRecords = directRecords.filter(
    ({ importer }) => normalizedImporter(importer) === workspaceRoot,
  );
  const candidates =
    importerRecords.length > 0 ? importerRecords : directRecords;
  const version = uniqueLockedVersion(candidates);
  return version === undefined
    ? manifest.resolution
    : { version, source: "lockfile" };
}
