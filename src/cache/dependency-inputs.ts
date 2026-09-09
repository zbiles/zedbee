/** Private cache/worker metadata. Never include source bytes or absolute paths. */
export type DependencyProbe =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly digest: string;
      readonly realPath: string;
    }
  | { readonly kind: "missing"; readonly path: string }
  | {
      readonly kind: "entry";
      readonly path: string;
      readonly identity: string;
      readonly entryType: "directory" | "denied";
    }
  | {
      readonly kind: "directory";
      readonly path: string;
      readonly identity: string;
      readonly names: readonly Readonly<{
        name: string;
        type: "file" | "directory" | "symlink" | "other";
      }>[];
    };

export interface DependencyInputManifest {
  readonly version: 1;
  readonly roots: string;
  readonly probes: readonly DependencyProbe[];
}

export const DEPENDENCY_LIMITS = Object.freeze({
  probes: 20_000,
  bytes: 64 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  names: 20_000,
  metadataBytes: 4 * 1024 * 1024,
});
const HASH = /^[a-f0-9]{64}$/u;
const ROOTS = new Set([
  "packages",
  "typescript",
  "repository",
  "baseline",
  "target",
]);

export function dependencyPathParts(value: unknown): readonly [string, string] {
  if (typeof value !== "string" || value.length > 4096)
    throw new TypeError("Invalid dependency path");
  const separator = value.indexOf(":");
  const root = value.slice(0, separator);
  const path = value.slice(separator + 1);
  if (
    !ROOTS.has(root) ||
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes(":")
  )
    throw new TypeError("Invalid dependency path");
  const parts = path.split("/");
  if (path !== "." && parts.some((part) => part === "" || part === "."))
    throw new TypeError("Invalid dependency path");
  let up = 0;
  while (parts[up] === "..") up++;
  if (up > 64 || parts.slice(up).includes(".."))
    throw new TypeError("Invalid dependency path");
  // Ancestor searches are limited to the compiler's package resolution surface.
  if (
    up > 0 &&
    !(
      parts[up] === "node_modules" ||
      (parts[up] === "package.json" && parts.length === up + 1)
    )
  )
    throw new TypeError("Invalid dependency ancestor");
  return [root, path];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid dependency manifest");
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw new TypeError("Invalid dependency fields");
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value))
    throw new TypeError("Invalid dependency digest");
  return value;
}

export function sanitizeDependencyInputManifest(
  value: unknown,
): DependencyInputManifest {
  const input = record(value);
  keys(input, ["version", "roots", "probes"]);
  if (
    input.version !== 1 ||
    !Array.isArray(input.probes) ||
    input.probes.length > DEPENDENCY_LIMITS.probes
  )
    throw new TypeError("Invalid dependency manifest");
  const seen = new Set<string>();
  let names = 0;
  let metadataBytes = 128;
  const charge = (text: string): void => {
    metadataBytes += Buffer.byteLength(text) + 256;
    if (metadataBytes > DEPENDENCY_LIMITS.metadataBytes)
      throw new TypeError("Oversized dependency metadata");
  };
  const probes = input.probes.map((raw): DependencyProbe => {
    const probe = record(raw);
    dependencyPathParts(probe.path);
    const path = probe.path as string;
    charge(path);
    const key = `${probe.kind === "directory" ? "listing" : "entry"}:${path}`;
    if (seen.has(key)) throw new TypeError("Duplicate dependency probe");
    seen.add(key);
    if (probe.kind === "missing") {
      keys(probe, ["kind", "path"]);
      return Object.freeze({ kind: "missing", path });
    }
    if (probe.kind === "file") {
      keys(probe, ["kind", "path", "digest", "realPath"]);
      const [canonicalRoot, canonicalPath] = dependencyPathParts(
        probe.realPath,
      );
      charge(probe.realPath as string);
      if (
        !["packages", "typescript", "baseline", "target"].includes(
          canonicalRoot,
        ) ||
        canonicalPath.split("/").includes("..")
      )
        throw new TypeError("Invalid canonical dependency path");
      return Object.freeze({
        kind: "file",
        path,
        digest: hash(probe.digest),
        realPath: probe.realPath as string,
      });
    }
    if (probe.kind === "entry") {
      keys(probe, ["kind", "path", "identity", "entryType"]);
      if (probe.entryType !== "directory" && probe.entryType !== "denied")
        throw new TypeError("Invalid dependency entry");
      return Object.freeze({
        kind: "entry",
        path,
        identity: hash(probe.identity),
        entryType: probe.entryType,
      });
    }
    if (probe.kind !== "directory" || !Array.isArray(probe.names))
      throw new TypeError("Invalid dependency probe");
    keys(probe, ["kind", "path", "identity", "names"]);
    names += probe.names.length;
    if (names > DEPENDENCY_LIMITS.names)
      throw new TypeError("Oversized dependency directory");
    const unique = new Set<string>();
    const entries = probe.names.map((rawName) => {
      const entry = record(rawName);
      keys(entry, ["name", "type"]);
      if (
        typeof entry.name !== "string" ||
        !entry.name ||
        entry.name.length > 255 ||
        /[\\/\0]/u.test(entry.name) ||
        entry.name === "." ||
        entry.name === ".." ||
        unique.has(entry.name)
      )
        throw new TypeError("Invalid dependency entry name");
      unique.add(entry.name);
      charge(entry.name);
      if (
        entry.type !== "file" &&
        entry.type !== "directory" &&
        entry.type !== "symlink" &&
        entry.type !== "other"
      )
        throw new TypeError("Invalid dependency entry type");
      return Object.freeze({ name: entry.name, type: entry.type });
    });
    return Object.freeze({
      kind: "directory",
      path,
      identity: hash(probe.identity),
      names: Object.freeze(entries),
    });
  });
  return Object.freeze({
    version: 1,
    roots: hash(input.roots),
    probes: Object.freeze(probes),
  });
}
