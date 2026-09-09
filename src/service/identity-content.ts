import { createHash } from "node:crypto";
import {
  constants,
  type BigIntStats,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  fstatSync,
  readSync,
  closeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { ServiceUnavailableError } from "./protocol.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function hashFile(
  path: string,
  collect = false,
  observed?: Map<string, BigIntStats>,
): { hash: string; text?: string; bytes: number } {
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(collect ? 1024 * 1024 : 256 * 1024 * 1024)
  )
    throw new ServiceUnavailableError();
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(file, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new ServiceUnavailableError();
    const hash = createHash("sha256"),
      parts: Buffer[] = [];
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const bytesRead = readSync(file, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (BigInt(bytes) > before.size) throw new ServiceUnavailableError();
      hash.update(buffer.subarray(0, bytesRead));
      if (collect) parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = lstatSync(path, { bigint: true }),
      final = fstatSync(file, { bigint: true });
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
    observed?.set(path, before);
    return {
      hash: hash.digest("hex"),
      bytes,
      ...(collect ? { text: Buffer.concat(parts).toString("utf8") } : {}),
    };
  } finally {
    closeSync(file);
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
function resolveDependency(root: string, name: string): string | undefined {
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
      const resolved = realpathSync(candidate);
      if (!lstatSync(resolved).isDirectory())
        throw new ServiceUnavailableError();
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}
export function installedContentIdentitySync(
  root: string,
  tree: string,
): string {
  root = realpathSync(root);
  const packages = [root],
    seen = new Set<string>(),
    records: string[] = [];
  const files: Array<{ path: string; label: string }> = [];
  const manifests = new Map<string, string>();
  const observed = new Map<string, BigIntStats>();
  const edges: Array<{
    root: string;
    name: string;
    resolved: string | undefined;
  }> = [];
  let directoryCount = 0,
    totalBytes = 0;
  function walk(directory: string, packageRoot: string): void {
    if (++directoryCount > 20000) throw new ServiceUnavailableError();
    const before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new ServiceUnavailableError();
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, packageRoot);
      else if (entry.isFile())
        files.push({
          path,
          label: JSON.stringify([packageRoot, relative(packageRoot, path)]),
        });
      else throw new ServiceUnavailableError();
      if (files.length > 100000) throw new ServiceUnavailableError();
    }
    const after = lstatSync(directory, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new ServiceUnavailableError();
    observed.set(directory, before);
  }
  for (let index = 0; index < packages.length; index++) {
    const packageRoot = packages[index]!;
    if (seen.has(packageRoot)) continue;
    seen.add(packageRoot);
    if (seen.size > 2048) throw new ServiceUnavailableError();
    const manifestPath = join(packageRoot, "package.json");
    const captured = hashFile(manifestPath, true);
    manifests.set(manifestPath, captured.hash);
    const manifest = JSON.parse(captured.text!) as Record<string, any>;
    if (
      !manifest ||
      typeof manifest !== "object" ||
      typeof manifest.name !== "string"
    )
      throw new ServiceUnavailableError();
    for (const [name, optional] of dependencyNames(manifest)) {
      const resolved = resolveDependency(packageRoot, name);
      if (!resolved && !optional) throw new ServiceUnavailableError();
      edges.push({ root: packageRoot, name, resolved });
      records.push(JSON.stringify([packageRoot, name, resolved ?? null]));
      if (resolved) packages.push(resolved);
    }
    if (packageRoot === root) {
      files.push({
        path: manifestPath,
        label: JSON.stringify([root, "package.json"]),
      });
      walk(join(root, tree), root);
    } else walk(packageRoot, packageRoot);
  }
  for (const file of files) {
    const content = hashFile(file.path, false, observed);
    totalBytes += content.bytes;
    if (totalBytes > 2 * 1024 * 1024 * 1024)
      throw new ServiceUnavailableError();
    if (manifests.has(file.path) && manifests.get(file.path) !== content.hash)
      throw new ServiceUnavailableError();
    records.push(JSON.stringify([file.label, content.hash]));
  }
  // A live installation is not an immutable snapshot. Reject changes observed
  // after an earlier directory walk/hash, including newly present optional or
  // shadowing packages. Never persist these stat observations across acquires.
  for (const edge of edges) {
    if (resolveDependency(edge.root, edge.name) !== edge.resolved)
      throw new ServiceUnavailableError();
  }
  for (const [path, before] of observed) {
    const after = lstatSync(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new ServiceUnavailableError();
  }
  return digest(JSON.stringify(records.sort()));
}
