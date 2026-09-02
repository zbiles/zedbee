import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";

const REGISTRY = "https://registry.npmjs.org/";
const CACHE_KEY_PREFIX = "make-fetch-happen:request-cache:";
const PACKUMENT_ACCEPT_TYPES = [
  "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
  "application/json",
] as const;
const cacheSeeds = new Map<string, Promise<void>>();

interface LockedPackage {
  readonly integrity: string;
  readonly resolved: string;
  readonly manifest: Record<string, unknown>;
}

async function npmCache(): Promise<string> {
  const override = process.env.ZEDBEE_NPM_SOURCE_CACHE_UNDER_TEST;
  if (override !== undefined && override.length > 0) return override;
  const result = await execa("npm", ["config", "get", "cache"], {
    reject: false,
    stdin: "ignore",
  });
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    throw new Error("Could not locate npm's populated package cache");
  }
  return result.stdout.trim();
}

function cacheContentPath(cacheRoot: string, integrity: string): string {
  const separator = integrity.indexOf("-");
  if (separator <= 0) throw new Error("Invalid package-cache integrity");
  const algorithm = integrity.slice(0, separator);
  const digest = Buffer.from(integrity.slice(separator + 1), "base64").toString(
    "hex",
  );
  if (!/^[a-z0-9]+$/u.test(algorithm) || digest.length < 5) {
    throw new Error("Invalid package-cache integrity");
  }
  return join(
    cacheRoot,
    "_cacache",
    "content-v2",
    algorithm,
    digest.slice(0, 2),
    digest.slice(2, 4),
    digest.slice(4),
  );
}

function cacheIndexPath(cacheRoot: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return join(
    cacheRoot,
    "_cacache",
    "index-v5",
    digest.slice(0, 2),
    digest.slice(2, 4),
    digest.slice(4),
  );
}

function cachedEntry(
  index: string,
  key: string,
): Record<string, unknown> & { readonly integrity: string } {
  for (const line of index.trim().split("\n").reverse()) {
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    try {
      const entry = JSON.parse(line.slice(separator + 1)) as {
        readonly key?: unknown;
        readonly integrity?: unknown;
      };
      if (entry.key === key && typeof entry.integrity === "string") {
        return entry as Record<string, unknown> & {
          readonly integrity: string;
        };
      }
    } catch {
      // cacache ignores incomplete index lines left by interrupted writers.
    }
  }
  throw new Error(`Could not read populated npm cache entry: ${key}`);
}

async function writeContent(cacheRoot: string, body: Buffer): Promise<string> {
  const integrity = `sha512-${createHash("sha512").update(body).digest("base64")}`;
  const path = cacheContentPath(cacheRoot, integrity);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { flag: "wx" }).catch((error: unknown) => {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { readonly code?: unknown }).code !== "EEXIST"
    ) {
      throw error;
    }
  });
  return integrity;
}

async function copyCacheEntry(
  sourceCache: string,
  targetCache: string,
  url: string,
): Promise<void> {
  const key = `${CACHE_KEY_PREFIX}${url}`;
  const sourceIndex = cacheIndexPath(sourceCache, key);
  const targetIndex = cacheIndexPath(targetCache, key);
  const index = await readFile(sourceIndex, "utf8");
  const integrity = cachedEntry(index, key).integrity;
  const sourceContent = cacheContentPath(sourceCache, integrity);
  const targetContent = cacheContentPath(targetCache, integrity);
  await Promise.all([
    mkdir(dirname(targetIndex), { recursive: true }),
    mkdir(dirname(targetContent), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(sourceIndex, targetIndex),
    copyFile(sourceContent, targetContent),
  ]);
}

async function copyCacheEntryIfPresent(
  sourceCache: string,
  targetCache: string,
  url: string,
): Promise<void> {
  try {
    await copyCacheEntry(sourceCache, targetCache, url);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { readonly code?: unknown }).code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

async function appendSyntheticManifest(
  cacheRoot: string,
  name: string,
  versions: ReadonlyMap<string, LockedPackage>,
): Promise<void> {
  const ordered = [...versions].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const body = Buffer.from(
    JSON.stringify({
      name,
      "dist-tags": { latest: ordered.at(-1)?.[0] },
      versions: Object.fromEntries(
        ordered.map(([version, locked]) => [
          version,
          {
            ...locked.manifest,
            dist: {
              integrity: locked.integrity,
              tarball: locked.resolved,
            },
          },
        ]),
      ),
    }),
  );
  const encodedName = name.startsWith("@") ? name.replace("/", "%2f") : name;
  const key = `${CACHE_KEY_PREFIX}${REGISTRY}${encodedName}`;
  const indexPath = cacheIndexPath(cacheRoot, key);
  let existing: Record<string, unknown> = {};
  try {
    existing = cachedEntry(await readFile(indexPath, "utf8"), key);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { readonly code?: unknown }).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const integrity = await writeContent(cacheRoot, body);
  const time = Date.now();
  const existingMetadata =
    typeof existing.metadata === "object" && existing.metadata !== null
      ? (existing.metadata as Record<string, unknown>)
      : {};
  const existingHeaders =
    typeof existingMetadata.resHeaders === "object" &&
    existingMetadata.resHeaders !== null
      ? (existingMetadata.resHeaders as Record<string, unknown>)
      : {};
  const {
    "content-encoding": _encoding,
    vary: _vary,
    ...headers
  } = existingHeaders;
  await mkdir(dirname(indexPath), { recursive: true });
  for (const accept of PACKUMENT_ACCEPT_TYPES) {
    const value = JSON.stringify({
      ...existing,
      key,
      integrity,
      time,
      size: body.length,
      metadata: {
        ...existingMetadata,
        time,
        url: `${REGISTRY}${encodedName}`,
        // make-fetch-happen matches cached responses by the complete Accept
        // list even when the response has no Vary header. npm requests both
        // compact and full packuments, so cache the synthetic full manifest
        // under both request variants.
        reqHeaders: { accept },
        resHeaders: {
          ...headers,
          "cache-control": "public, max-age=31557600",
          "content-type": "application/json",
        },
        options: { compress: true },
      },
    });
    await appendFile(
      indexPath,
      `\n${createHash("sha1").update(value).digest("hex")}\t${value}`,
    );
  }
}

async function runBounded<T>(
  values: readonly T[],
  action: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await action(values[index]!);
      }
    }),
  );
}

async function seedOfflineCache(
  cacheRoot: string,
  packageRoot: string,
): Promise<void> {
  const sourceCache = await npmCache();
  await mkdir(join(cacheRoot, "_cacache", "tmp"), { recursive: true });
  const lock = JSON.parse(
    await readFile(join(packageRoot, "package-lock.json"), "utf8"),
  ) as {
    readonly packages?: Readonly<
      Record<
        string,
        {
          readonly dev?: unknown;
          readonly integrity?: unknown;
          readonly resolved?: unknown;
        }
      >
    >;
  };
  const packages = new Map<string, Map<string, LockedPackage>>();
  const tarballUrls = new Set<string>();

  await runBounded(
    Object.entries(lock.packages ?? {}),
    async ([packagePath, metadata]) => {
      if (
        packagePath.length === 0 ||
        metadata.dev === true ||
        typeof metadata.integrity !== "string" ||
        typeof metadata.resolved !== "string"
      ) {
        return;
      }
      const installedPath = join(packageRoot, packagePath);
      try {
        await lstat(installedPath);
      } catch {
        return;
      }
      const manifest = JSON.parse(
        await readFile(join(installedPath, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      if (
        typeof manifest.name !== "string" ||
        typeof manifest.version !== "string"
      ) {
        throw new Error("Invalid installed package metadata");
      }
      const versions = packages.get(manifest.name) ?? new Map();
      versions.set(manifest.version, {
        integrity: metadata.integrity,
        resolved: metadata.resolved,
        manifest,
      });
      packages.set(manifest.name, versions);
      tarballUrls.add(metadata.resolved);
    },
  );

  await runBounded([...tarballUrls].sort(), (url) =>
    copyCacheEntry(sourceCache, cacheRoot, url),
  );
  await runBounded([...packages.keys()].sort(), (name) => {
    const encodedName = name.startsWith("@") ? name.replace("/", "%2f") : name;
    return copyCacheEntryIfPresent(
      sourceCache,
      cacheRoot,
      `${REGISTRY}${encodedName}`,
    );
  });
  await runBounded(
    [...packages].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
    ([name, versions]) => appendSyntheticManifest(cacheRoot, name, versions),
  );
}

async function ensureOfflineCache(
  cacheRoot: string,
  packageRoot: string,
): Promise<void> {
  const existing = cacheSeeds.get(cacheRoot);
  if (existing !== undefined) return existing;
  const pending = seedOfflineCache(cacheRoot, packageRoot);
  cacheSeeds.set(cacheRoot, pending);
  return pending;
}

export async function installPackedFixture(
  tarballPath: string,
  packageRoot: string,
  repositoryRoot: string,
  cacheRoot: string,
): Promise<void> {
  await ensureOfflineCache(cacheRoot, packageRoot);
  const installed = await execa(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarballPath,
    ],
    {
      cwd: repositoryRoot,
      env: { npm_config_cache: cacheRoot, npm_config_registry: REGISTRY },
      reject: false,
      stdin: "ignore",
    },
  );
  if (installed.exitCode !== 0) {
    throw new Error(`Could not install packed Zedbee: ${installed.stderr}`);
  }
}
