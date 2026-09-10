import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CacheableObservationCheckId } from "./metadata.js";
import { isCacheableObservationCheck } from "./metadata.js";

export type InstalledPackageVersionReader = (
  packageName: string,
) => string | undefined;

interface EngineIdentityMetadata {
  readonly packages: readonly string[];
  readonly revision?: string;
}

const ENGINE_IDENTITY_METADATA = Object.freeze({
  deadCode: Object.freeze({
    packages: Object.freeze([
      "knip",
      "typescript",
      "@napi-rs/wasm-runtime",
      "@tybys/wasm-util",
      "@emnapi/core",
      "@emnapi/runtime",
    ]),
    revision: "knip-snapshot-wasi-11.24.2-07f08138-v4",
  }),
  lint: Object.freeze({
    packages: Object.freeze(["eslint", "typescript-eslint", "typescript"]),
    revision: "captured-inputs-v1",
  }),
  types: Object.freeze({
    packages: Object.freeze(["typescript"]),
    revision: "captured-inputs-v1",
  }),
  cyclomaticComplexity: Object.freeze({
    packages: Object.freeze(["eslint", "typescript-eslint", "typescript"]),
    revision: "complexity-v3",
  }),
  readabilityComplexity: Object.freeze({
    packages: Object.freeze(["eslint", "typescript-eslint", "typescript"]),
    revision: "zedbee-readability-v3",
  }),
  structuralSecurity: Object.freeze({
    packages: Object.freeze(["@ast-grep/napi", "typescript"]),
    revision: "zedbee-structural-rules-v3",
  }),
  duplication: Object.freeze({
    packages: Object.freeze(["jscpd", "typescript"]),
    revision: "zedbee-clone-normalization-v2",
  }),
  dependencyArchitecture: Object.freeze({
    packages: Object.freeze(["dependency-cruiser", "typescript"]),
    revision: "zedbee-rules-v1",
  }),
  reactCorrectness: Object.freeze({
    packages: Object.freeze([
      "eslint",
      "typescript-eslint",
      "typescript",
      "eslint-plugin-react",
      "eslint-plugin-react-hooks",
      "semver",
    ]),
    revision: "zedbee-react-calibration-v2",
  }),
  reactAccessibility: Object.freeze({
    packages: Object.freeze([
      "eslint",
      "typescript-eslint",
      "typescript",
      "eslint-plugin-jsx-a11y",
    ]),
  }),
}) satisfies Readonly<
  Record<CacheableObservationCheckId, EngineIdentityMetadata>
>;

function versionFromManifest(
  packageName: string,
  manifestPath: string,
): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("name" in parsed) ||
      parsed.name !== packageName ||
      !("version" in parsed) ||
      typeof parsed.version !== "string" ||
      parsed.version.trim() === ""
    ) {
      return undefined;
    }
    return parsed.version;
  } catch {
    return undefined;
  }
}

export function readInstalledPackageVersion(
  packageName: string,
): string | undefined {
  try {
    const direct = import.meta.resolve(`${packageName}/package.json`);
    const version = versionFromManifest(packageName, fileURLToPath(direct));
    if (version !== undefined) return version;
  } catch {
    // Some packages do not export package.json; locate it from their entry.
  }

  try {
    let directory = dirname(fileURLToPath(import.meta.resolve(packageName)));
    while (true) {
      const version = versionFromManifest(
        packageName,
        join(directory, "package.json"),
      );
      if (version !== undefined) return version;
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  } catch {
    return undefined;
  }
}

export function createObservationCacheEngineIdentityResolver(
  readVersion: InstalledPackageVersionReader,
): (checkId: string) => string | undefined {
  return (checkId) => {
    if (!isCacheableObservationCheck(checkId)) return undefined;
    const metadata = ENGINE_IDENTITY_METADATA[checkId];
    const identities: string[] = [];
    for (const packageName of metadata.packages) {
      const version = readVersion(packageName);
      if (version === undefined) return undefined;
      identities.push(`${packageName}@${version}`);
    }
    if ("revision" in metadata) identities.push(metadata.revision);
    return identities.join("+");
  };
}

const installedEngineIdentity = createObservationCacheEngineIdentityResolver(
  readInstalledPackageVersion,
);

export function observationCacheEngineIdentity(
  checkId: string,
): string | undefined {
  return installedEngineIdentity(checkId);
}
