import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { ServiceUnavailableError } from "./protocol.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export interface ServiceIdentity {
  readonly key: string;
  readonly content: string;
  readonly entry: string;
  readonly directory: string;
}
async function hashFile(
  path: string,
  collect = false,
): Promise<{ hash: string; text?: string; bytes: number }> {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(collect ? 1024 * 1024 : 256 * 1024 * 1024)
  )
    throw new ServiceUnavailableError();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new ServiceUnavailableError();
    const hash = createHash("sha256"),
      parts: Buffer[] = [];
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const result = await file.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (BigInt(bytes) > before.size) throw new ServiceUnavailableError();
      hash.update(buffer.subarray(0, result.bytesRead));
      if (collect)
        parts.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    const after = await lstat(path, { bigint: true }),
      final = await file.stat({ bigint: true });
    for (const observed of [after, final])
      if (
        observed.dev !== before.dev ||
        observed.ino !== before.ino ||
        observed.size !== before.size ||
        observed.mtimeNs !== before.mtimeNs ||
        observed.ctimeNs !== before.ctimeNs
      )
        throw new ServiceUnavailableError();
    if (BigInt(bytes) !== before.size) throw new ServiceUnavailableError();
    return {
      hash: hash.digest("hex"),
      bytes,
      ...(collect ? { text: Buffer.concat(parts).toString("utf8") } : {}),
    };
  } finally {
    await file.close();
  }
}
function dependencyNames(manifest: Record<string, any>): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const kind of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const values = manifest[kind];
    if (values === undefined) continue;
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new ServiceUnavailableError();
    for (const [name, version] of Object.entries(values)) {
      if (
        !/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/u.test(name) ||
        name === "." ||
        name === ".." ||
        typeof version !== "string"
      )
        throw new ServiceUnavailableError();
      const optional =
        kind === "optionalDependencies" ||
        (kind === "peerDependencies" &&
          manifest.peerDependenciesMeta?.[name]?.optional === true);
      if (kind === "optionalDependencies" || !result.has(name) || !optional)
        result.set(name, optional);
    }
  }
  return result;
}
/** Actual Node package search paths, with global/NODE_PATH roots excluded. */
async function resolveDependency(
  root: string,
  name: string,
): Promise<string | undefined> {
  // Trailing slash asks for package lookup even for names such as punycode
  // that also name a builtin. Declared installed contents still join identity.
  const locations =
    createRequire(join(root, "package.json")).resolve.paths(`${name}/`) ?? [];
  const allowed = new Set<string>();
  for (let directory = root; ; directory = dirname(directory)) {
    if (basename(directory) !== "node_modules")
      allowed.add(join(directory, "node_modules"));
    if (directory === dirname(directory)) break;
  }
  for (const location of locations) {
    if (!allowed.has(location)) continue;
    const candidate = join(location, name);
    try {
      const resolved = await realpath(candidate);
      if (!(await lstat(resolved)).isDirectory())
        throw new ServiceUnavailableError();
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}
export async function installedContentIdentity(
  root: string,
  tree: string,
): Promise<string> {
  root = await realpath(root);
  const packages = [root],
    seen = new Set<string>(),
    records: string[] = [];
  const files: Array<{ path: string; label: string }> = [];
  const manifests = new Map<string, string>();
  let directoryCount = 0,
    totalBytes = 0;
  async function walk(directory: string, packageRoot: string): Promise<void> {
    if (++directoryCount > 20000) throw new ServiceUnavailableError();
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new ServiceUnavailableError();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, packageRoot);
      else if (entry.isFile())
        files.push({
          path,
          label: JSON.stringify([packageRoot, relative(packageRoot, path)]),
        });
      else throw new ServiceUnavailableError();
      if (files.length > 100000) throw new ServiceUnavailableError();
    }
    const after = await lstat(directory, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new ServiceUnavailableError();
  }
  for (let index = 0; index < packages.length; index++) {
    const packageRoot = packages[index]!;
    if (seen.has(packageRoot)) continue;
    seen.add(packageRoot);
    if (seen.size > 2048) throw new ServiceUnavailableError();
    const manifestPath = join(packageRoot, "package.json");
    const captured = await hashFile(manifestPath, true);
    manifests.set(manifestPath, captured.hash);
    const manifest = JSON.parse(captured.text!) as Record<string, any>;
    if (
      !manifest ||
      typeof manifest !== "object" ||
      typeof manifest.name !== "string"
    )
      throw new ServiceUnavailableError();
    for (const [name, optional] of dependencyNames(manifest)) {
      const resolved = await resolveDependency(packageRoot, name);
      if (!resolved && !optional) throw new ServiceUnavailableError();
      records.push(JSON.stringify([packageRoot, name, resolved ?? null]));
      if (resolved) packages.push(resolved);
    }
    if (packageRoot === root) {
      files.push({
        path: manifestPath,
        label: JSON.stringify([root, "package.json"]),
      });
      await walk(join(root, tree), root);
    } else await walk(packageRoot, packageRoot);
  }
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++]!;
        const content = await hashFile(file.path);
        totalBytes += content.bytes;
        if (totalBytes > 2 * 1024 * 1024 * 1024)
          throw new ServiceUnavailableError();
        if (
          manifests.has(file.path) &&
          manifests.get(file.path) !== content.hash
        )
          throw new ServiceUnavailableError();
        records.push(JSON.stringify([file.label, content.hash]));
      }
    }),
  );
  return digest(JSON.stringify(records.sort()));
}
export async function serviceIdentity(
  directory?: string,
): Promise<ServiceIdentity> {
  const source = import.meta.url.endsWith(".ts"),
    tree = source ? "src" : "dist";
  const root = await realpath(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const runtime = [
    await realpath(process.execPath),
    process.version,
    process.versions.modules,
    process.platform,
    process.arch,
  ];
  const key = digest(JSON.stringify(["zedbee-service-v1", root, runtime]));
  const content = digest(
    JSON.stringify([key, await installedContentIdentity(root, tree)]),
  );
  return {
    key,
    content,
    entry: join(root, tree, "service", `entry.${source ? "ts" : "js"}`),
    directory:
      directory ?? join(await realpath(tmpdir()), `zedbee-${key.slice(0, 24)}`),
  };
}
