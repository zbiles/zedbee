import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";

const REGISTRY = "https://registry.npmjs.org/";
const cacheSeeds = new Map<string, Promise<void>>();

interface LockedPackage {
  readonly integrity: string;
  readonly resolved: string;
  readonly manifest: Record<string, unknown>;
}

async function npmCache(): Promise<string> {
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
  if (separator <= 0) throw new Error("Invalid package-lock integrity");
  const algorithm = integrity.slice(0, separator);
  const digest = Buffer.from(integrity.slice(separator + 1), "base64").toString(
    "hex",
  );
  if (!/^[a-z0-9]+$/u.test(algorithm) || digest.length < 5) {
    throw new Error("Invalid package-lock integrity");
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

async function writeIndexEntry(
  cacheRoot: string,
  key: string,
  integrity: string,
  size: number,
  contentType: string,
): Promise<void> {
  const digest = createHash("sha256").update(key).digest("hex");
  const path = join(
    cacheRoot,
    "_cacache",
    "index-v5",
    digest.slice(0, 2),
    digest.slice(2, 4),
    digest.slice(4),
  );
  const url = key.slice("make-fetch-happen:request-cache:".length);
  const time = Date.now();
  const isJson = contentType === "application/json";
  const value = JSON.stringify({
    key,
    integrity,
    time,
    size,
    metadata: {
      time,
      url,
      reqHeaders: isJson ? { accept: "application/json" } : {},
      resHeaders: {
        "cache-control": "public, max-age=31557600",
        "content-type": contentType,
        ...(isJson ? { vary: "accept-encoding, accept" } : {}),
      },
      options: { compress: true },
    },
  });
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `\n${createHash("sha1").update(value).digest("hex")}\t${value}`,
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
  const copied = new Set<string>();
  for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
    if (
      packagePath.length === 0 ||
      metadata.dev === true ||
      typeof metadata.integrity !== "string" ||
      typeof metadata.resolved !== "string"
    ) {
      continue;
    }
    const installedPath = join(packageRoot, packagePath);
    try {
      await lstat(installedPath);
    } catch {
      continue;
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
    const versions =
      packages.get(manifest.name) ?? new Map<string, LockedPackage>();
    versions.set(manifest.version, {
      integrity: metadata.integrity,
      resolved: metadata.resolved,
      manifest,
    });
    packages.set(manifest.name, versions);

    const source = cacheContentPath(sourceCache, metadata.integrity);
    const target = cacheContentPath(cacheRoot, metadata.integrity);
    if (!copied.has(target)) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      copied.add(target);
    }
    await writeIndexEntry(
      cacheRoot,
      `make-fetch-happen:request-cache:${metadata.resolved}`,
      metadata.integrity,
      (await stat(target)).size,
      "application/octet-stream",
    );
  }

  for (const [name, versions] of packages) {
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
    const integrity = await writeContent(cacheRoot, body);
    const encodedName = name.startsWith("@") ? name.replace("/", "%2f") : name;
    await writeIndexEntry(
      cacheRoot,
      `make-fetch-happen:request-cache:${REGISTRY}${encodedName}`,
      integrity,
      body.length,
      "application/json",
    );
  }
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
