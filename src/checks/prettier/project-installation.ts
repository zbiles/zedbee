import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";
import { isContainedPath } from "../../inspection/read-json.js";
import { ProjectPrettierFailureError } from "./project-error.js";
import type { ProjectPrettierInstallation } from "./project-types.js";
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const IDENTITY_CHUNK_BYTES = 64 * 1024;

interface ManifestDeclaration {
  readonly range: string;
  readonly section: string;
}

function manifestPrettierDeclaration(
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

async function readBounded(path: string, maxBytes: number): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > BigInt(maxBytes)) {
    throw new Error("unbounded read");
  }
  return readFile(path, "utf8");
}

/**
 * Resolves the Prettier declaration from the *selected snapshot*, never the
 * live working tree, so an unstaged manifest edit cannot change whether a
 * staged or committed scan may execute the formatter.
 */
async function snapshotPrettierDeclaration(
  snapshotRoot: string,
  projectRoot: string,
): Promise<ManifestDeclaration> {
  let directory = resolve(snapshotRoot, projectRoot);
  while (isContainedPath(snapshotRoot, directory)) {
    try {
      const manifest = JSON.parse(
        await readBounded(join(directory, "package.json"), MAX_MANIFEST_BYTES),
      );
      const declaration = manifestPrettierDeclaration(manifest);
      if (declaration !== undefined) return declaration;
    } catch {
      /* Missing or unreadable manifest; keep walking upward. */
    }
    if (directory === snapshotRoot) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new ProjectPrettierFailureError({
    code: "PROJECT_PRETTIER_INSTALL_MISSING",
    message:
      "The selected snapshot does not declare Prettier for this project.",
    projectRoot: projectRoot === "" ? "." : projectRoot,
  });
}

async function resolveEntryUrl(packageRoot: string): Promise<string> {
  const manifestPath = join(packageRoot, "package.json");
  const esmEntry = join(packageRoot, "index.mjs");
  try {
    const metadata = await lstat(esmEntry);
    if (metadata.isFile()) return pathToFileURL(esmEntry).href;
  } catch {
    /* Fall through to package exports. */
  }
  const require = createRequire(manifestPath);
  try {
    return pathToFileURL(require.resolve("prettier")).href;
  } catch {
    /* Fall through to declared entry points. */
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    main?: string;
    module?: string;
  };
  const candidate =
    (typeof manifest.module === "string" &&
      join(packageRoot, manifest.module)) ||
    (typeof manifest.main === "string" && join(packageRoot, manifest.main));
  if (typeof candidate === "string") {
    return pathToFileURL(resolve(candidate)).href;
  }
  return pathToFileURL(join(packageRoot, "index.mjs")).href;
}

export async function resolveProjectPrettierInstallation(
  repositoryRoot: string,
  projectRoot: string,
  snapshotRoot: string,
): Promise<ProjectPrettierInstallation> {
  const checkoutRoot = await realpath(repositoryRoot);
  const declaration = await snapshotPrettierDeclaration(
    snapshotRoot,
    projectRoot,
  );
  const projectDirectory = resolve(repositoryRoot, projectRoot);
  let current = await realpath(projectDirectory).catch(() => projectDirectory);
  while (true) {
    const manifestPath = join(
      current,
      "node_modules",
      "prettier",
      "package.json",
    );
    try {
      const canonicalManifest = await realpath(manifestPath);
      const manifestMetadata = await lstat(canonicalManifest);
      if (
        !manifestMetadata.isFile() ||
        manifestMetadata.size > BigInt(MAX_MANIFEST_BYTES)
      ) {
        throw new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_INSTALL_MISSING",
          message:
            "The installed Prettier manifest is unreadable or too large.",
          projectRoot: projectRoot === "" ? "." : projectRoot,
        });
      }
      const bytes = await readFile(canonicalManifest);
      const manifest = JSON.parse(bytes.toString("utf8")) as {
        version?: unknown;
      };
      if (typeof manifest.version !== "string") break;
      const packageRoot = dirname(canonicalManifest);
      const entryUrl = await resolveEntryUrl(packageRoot);
      const normalizedVersion = semver.valid(manifest.version);
      if (
        normalizedVersion === null ||
        !semver.satisfies(normalizedVersion, ">=3.0.0 <4.0.0") ||
        !satisfiesDeclaredRange(normalizedVersion, declaration.range)
      ) {
        throw new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_VERSION_UNSUPPORTED",
          message: `The installed Prettier ${manifest.version} does not satisfy the supported range >=3.0.0 <4.0.0 or the project's declared ${declaration.range}.`,
          projectRoot: projectRoot === "" ? "." : projectRoot,
        });
      }
      // Identity covers the executable entry bytes, the manifest bytes, and
      // the validated realpath, so an in-place engine swap is detectable. The
      // entry is stat-checked before reading: a too-large or unreadable entry
      // is an explicit failure, never a partial or empty-byte identity.
      const entryPath = fileURLToPath(entryUrl);
      const entryMetadata = await lstat(entryPath);
      if (
        !entryMetadata.isFile() ||
        entryMetadata.size > BigInt(MAX_ENTRY_BYTES)
      ) {
        throw new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_INSTALL_MISSING",
          message:
            "The installed Prettier entry is unreadable or too large to validate.",
          projectRoot: projectRoot === "" ? "." : projectRoot,
        });
      }
      const entryHash = createHash("sha256");
      {
        const handle = await open(entryPath, "r");
        try {
          const chunk = Buffer.alloc(IDENTITY_CHUNK_BYTES);
          while (true) {
            const { bytesRead } = await handle.read(
              chunk,
              0,
              chunk.length,
              null,
            );
            if (bytesRead === 0) break;
            entryHash.update(chunk.subarray(0, bytesRead));
          }
        } finally {
          await handle.close().catch(() => undefined);
        }
      }
      const identity = createHash("sha256")
        .update(entryHash.digest())
        .update("\0")
        .update(bytes)
        .update("\0")
        .update(packageRoot, "utf8")
        .digest("hex");
      return Object.freeze({
        projectRoot: projectRoot === "" ? "." : projectRoot,
        packageRoot,
        entryUrl,
        version: normalizedVersion,
        declaredRange: declaration.range,
        identity,
      });
    } catch (error) {
      if (error instanceof ProjectPrettierFailureError) throw error;
      /* Try the next hoisted level. */
    }
    if (current === checkoutRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new ProjectPrettierFailureError({
    code: "PROJECT_PRETTIER_INSTALL_MISSING",
    message:
      "No installed Prettier satisfying the project declaration was found.",
    projectRoot: projectRoot === "" ? "." : projectRoot,
  });
}

function satisfiesDeclaredRange(
  version: string,
  declaredRange: string,
): boolean {
  const normalizedRange = semver.validRange(declaredRange);
  if (normalizedRange === null) return true;
  try {
    return semver.satisfies(version, normalizedRange);
  } catch {
    return false;
  }
}
