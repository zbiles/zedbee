import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { getCurrentTest } from "@vitest/runner";
import { execa } from "execa";

const CACHE_KEY_PREFIX = "make-fetch-happen:request-cache:";

interface LockedPackage {
  readonly integrity: string;
  readonly manifest: Record<string, unknown>;
  readonly tarballPath: string;
}

interface LocalRegistry {
  readonly url: string;
  close(): Promise<void>;
}

interface PackedInstallOptions {
  readonly cancelSignal?: AbortSignal;
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

function cachedIntegrity(index: string, key: string): string {
  for (const line of index.trim().split("\n").reverse()) {
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    try {
      const entry = JSON.parse(line.slice(separator + 1)) as {
        readonly key?: unknown;
        readonly integrity?: unknown;
      };
      if (entry.key === key && typeof entry.integrity === "string") {
        return entry.integrity;
      }
    } catch {
      // cacache ignores incomplete index lines left by interrupted writers.
    }
  }
  throw new Error(`Could not read populated npm cache entry: ${key}`);
}

async function cachedTarballPath(
  cacheRoot: string,
  url: string,
): Promise<string> {
  const key = `${CACHE_KEY_PREFIX}${url}`;
  const index = await readFile(cacheIndexPath(cacheRoot, key), "utf8");
  return cacheContentPath(cacheRoot, cachedIntegrity(index, key));
}

async function runBounded<T>(
  values: readonly T[],
  action: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await action(values[index]!);
      }
    }),
  );
}

async function lockedProductionPackages(
  packageRoot: string,
): Promise<Map<string, Map<string, LockedPackage>>> {
  const sourceCache = await npmCache();
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
      const tarballPath = await cachedTarballPath(
        sourceCache,
        metadata.resolved,
      );
      const versions = packages.get(manifest.name) ?? new Map();
      versions.set(manifest.version, {
        integrity: metadata.integrity,
        manifest,
        tarballPath,
      });
      packages.set(manifest.name, versions);
    },
  );
  return packages;
}

function tarballId(name: string, version: string): string {
  return createHash("sha256")
    .update(name)
    .update("\0")
    .update(version)
    .digest("hex");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}

function isolatedNpmEnvironment(
  cacheRoot: string,
  registryUrl: string,
  userConfigPath: string,
  globalConfigPath: string,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "http_proxy" ||
      normalized === "https_proxy" ||
      normalized === "all_proxy" ||
      (normalized.startsWith("npm_config_") &&
        (normalized.includes("registry") || normalized.includes("proxy")))
    ) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    npm_config_cache: cacheRoot,
    npm_config_globalconfig: globalConfigPath,
    npm_config_noproxy: "127.0.0.1,localhost",
    npm_config_offline: "false",
    npm_config_registry: registryUrl,
    npm_config_userconfig: userConfigPath,
  };
}

async function startLocalRegistry(packageRoot: string): Promise<LocalRegistry> {
  const packages = await lockedProductionPackages(packageRoot);
  const tarballs = new Map<string, string>();
  for (const [name, versions] of packages) {
    for (const [version, locked] of versions) {
      tarballs.set(tarballId(name, version), locked.tarballPath);
    }
  }

  let registryUrl = "";
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", registryUrl).pathname;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (pathname.startsWith("/tarballs/") && pathname.endsWith(".tgz")) {
      const id = pathname.slice("/tarballs/".length, -".tgz".length);
      const path = tarballs.get(id);
      if (path === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(path);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
      return;
    }

    let name: string;
    try {
      name = decodeURIComponent(pathname.slice(1));
    } catch {
      response.writeHead(400).end();
      return;
    }
    const versions = packages.get(name);
    if (versions === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "package not found" }));
      return;
    }
    const ordered = [...versions].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const body = JSON.stringify({
      name,
      "dist-tags": { latest: ordered.at(-1)?.[0] },
      versions: Object.fromEntries(
        ordered.map(([version, locked]) => [
          version,
          {
            ...locked.manifest,
            dist: {
              integrity: locked.integrity,
              tarball: `${registryUrl}tarballs/${tarballId(name, version)}.tgz`,
            },
          },
        ]),
      ),
    });
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Could not start the local package registry");
  }
  registryUrl = `http://127.0.0.1:${(address as AddressInfo).port}/`;
  return { url: registryUrl, close: () => closeServer(server) };
}

export async function installPackedFixture(
  tarballPath: string,
  packageRoot: string,
  repositoryRoot: string,
  cacheRoot: string,
  options: PackedInstallOptions = {},
): Promise<void> {
  await mkdir(cacheRoot, { recursive: true });
  const userConfig = join(cacheRoot, "isolated-user.npmrc");
  const globalConfig = join(cacheRoot, "isolated-global.npmrc");
  await Promise.all([writeFile(userConfig, ""), writeFile(globalConfig, "")]);
  const registry = await startLocalRegistry(packageRoot);
  try {
    const cancelSignal =
      options.cancelSignal ?? getCurrentTest()?.context.signal;
    const installed = await execa(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
      {
        cwd: repositoryRoot,
        env: isolatedNpmEnvironment(
          cacheRoot,
          registry.url,
          userConfig,
          globalConfig,
        ),
        extendEnv: false,
        killDescendants: true,
        reject: false,
        stdin: "ignore",
        timeout: 150_000,
        ...(cancelSignal === undefined ? {} : { cancelSignal }),
      },
    );
    if (installed.exitCode !== 0) {
      throw new Error(`Could not install packed Zedbee: ${installed.stderr}`);
    }
  } finally {
    await registry.close();
  }
}
