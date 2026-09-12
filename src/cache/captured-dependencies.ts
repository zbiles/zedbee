import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { capturedSourceInput } from "../inspection/source-capture.js";
import {
  DEPENDENCY_LIMITS,
  dependencyPathParts,
  isInstalledDependencyPath,
  sanitizeDependencyInputManifest,
  type DependencyInputManifest,
  type DependencyProbe,
} from "./dependency-inputs.js";

export interface DependencyCaptureContext {
  readonly repositoryRoot: string;
  readonly snapshots?: Readonly<{ baselineDir: string; targetDir: string }>;
}
type Entry = {
  readonly probe: Exclude<DependencyProbe, { kind: "directory" }>;
  readonly text?: string;
  readonly bytes?: Buffer;
  readonly passthrough?: string;
  readonly unavailable?: boolean;
};
const digest = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
function contained(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
}
function canonical(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
function decode(buffer: Buffer): string {
  if (buffer[0] === 254 && buffer[1] === 255) {
    const even = buffer.subarray(0, buffer.length & ~1);
    even.swap16();
    return buffer.toString("utf16le", 2);
  }
  if (buffer[0] === 255 && buffer[1] === 254)
    return buffer.toString("utf16le", 2);
  return buffer.toString(
    "utf8",
    buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191 ? 3 : 0,
  );
}

/** One collect owns this view; callers may share it across sides and programs. */
export class CapturedDependencies {
  private readonly roots: Readonly<Record<string, string>>;
  private readonly aliases: Readonly<Record<string, string>>;
  private readonly allowed: Readonly<Record<string, string | undefined>>;
  private readonly rootsIdentity: string;
  private readonly entries = new Map<string, Entry>();
  private readonly listings = new Map<
    string,
    Extract<DependencyProbe, { kind: "directory" }>
  >();
  private bytes = 0;
  private names = 0;
  private metadataBytes = 128;
  private supported = true;

  constructor(
    readonly context: DependencyCaptureContext,
    readonly snapshotOnly: boolean | "knip" = false,
    private readonly useCapturedSources = true,
  ) {
    this.aliases = {
      packages: resolve(context.repositoryRoot, "node_modules"),
      typescript: dirname(fileURLToPath(import.meta.resolve("typescript"))),
      repository: resolve(context.repositoryRoot),
      ...(context.snapshots === undefined
        ? {}
        : {
            baseline: resolve(context.snapshots.baselineDir),
            target: resolve(context.snapshots.targetDir),
          }),
    };
    this.roots = Object.fromEntries(
      Object.entries(this.aliases).map(([name, path]) => [
        name,
        canonical(path) ?? path,
      ]),
    );
    this.allowed = snapshotOnly
      ? {
          baseline:
            context.snapshots === undefined
              ? undefined
              : canonical(this.roots.baseline!),
          target:
            context.snapshots === undefined
              ? undefined
              : canonical(this.roots.target!),
        }
      : {
          packages: canonical(this.roots.packages!),
          typescript: canonical(this.roots.typescript!),
        };
    this.rootsIdentity = digest(
      JSON.stringify(
        snapshotOnly
          ? {
              policy:
                snapshotOnly === "knip"
                  ? "knip-snapshot-manifests-v2"
                  : "knip-snapshot-v1",
              repository: this.roots.repository,
            }
          : {
              policy: "installed-packages-v2",
              repository: this.roots.repository,
              allowed: this.allowed,
            },
      ),
    );
  }

  private allowedRoot(real: string): readonly [string, string] | undefined {
    const root = Object.entries(this.allowed).find(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && contained(entry[1], real),
    );
    if (root !== undefined) return root;
    const repository = this.roots.repository!;
    // Knip may read installed command metadata, never installed source code.
    // Canonical containment also rejects package links into live source/outside.
    if (
      this.snapshotOnly === "knip" &&
      basename(real) === "package.json" &&
      contained(repository, real) &&
      isInstalledDependencyPath(relative(repository, real).split(sep).join("/"))
    )
      return ["repository", repository];
    if (
      !this.snapshotOnly &&
      contained(repository, real) &&
      isInstalledDependencyPath(relative(repository, real).split(sep).join("/"))
    )
      return ["repository", repository];
    return undefined;
  }

  private identify(path: string): string {
    const absolute = resolve(path);
    const priority = (name: string) =>
      this.snapshotOnly
        ? name === "baseline"
          ? 2
          : name === "target"
            ? 1
            : 0
        : 0;
    for (const [name, root] of Object.entries(this.aliases).sort(
      (a, b) => b[1].length - a[1].length || priority(b[0]) - priority(a[0]),
    )) {
      if (contained(root, absolute))
        return `${name}:${relative(root, absolute).split(sep).join("/") || "."}`;
    }
    for (const [name, root] of Object.entries(this.roots)) {
      if (contained(root, absolute))
        return `${name}:${relative(root, absolute).split(sep).join("/") || "."}`;
    }
    for (const [name, root] of Object.entries(this.roots)) {
      // Normalize only ancestry shared with the trusted root. Resolving the
      // candidate's parent here would erase a dependency-directory symlink.
      let shared = this.aliases[name]!;
      while (!contained(shared, absolute) && dirname(shared) !== shared)
        shared = dirname(shared);
      const canonicalAbsolute = resolve(
        canonical(shared) ?? shared,
        relative(shared, absolute),
      );
      const candidate = `${name}:${relative(root, canonicalAbsolute).split(sep).join("/")}`;
      try {
        dependencyPathParts(candidate);
        return candidate;
      } catch {
        /* try another semantic ancestor */
      }
    }
    throw new TypeError("Unsupported dependency scope");
  }

  private path(identifier: string): string {
    const [name, path] = dependencyPathParts(identifier);
    const root = this.roots[name];
    if (root === undefined) throw new TypeError("Unavailable dependency root");
    return resolve(root, ...path.split("/"));
  }

  private retain(bytes: number): boolean {
    this.metadataBytes += bytes;
    if (
      this.metadataBytes > DEPENDENCY_LIMITS.metadataBytes ||
      this.entries.size + this.listings.size >= DEPENDENCY_LIMITS.probes
    ) {
      this.supported = false;
      return false;
    }
    return true;
  }

  private capture(path: string): Entry {
    const absolute = resolve(path);
    let identifier: string;
    try {
      identifier = this.identify(absolute);
    } catch {
      this.supported = false;
      identifier = `unsupported:${absolute}`;
    }
    const previous = this.entries.get(identifier);
    if (previous !== undefined) return previous;
    if (this.snapshotOnly && this.useCapturedSources) {
      for (const name of ["baseline", "target"] as const) {
        const root = this.roots[name];
        if (root === undefined || !contained(root, absolute)) continue;
        const input = capturedSourceInput(
          root,
          relative(root, absolute).split(sep).join("/"),
        );
        if (
          input?.entry?.targetKind !== "file" ||
          input.text === undefined ||
          input.digest === undefined
        )
          continue;
        const bytes = Buffer.from(input.text, "utf8");
        if (
          digest(bytes) !== input.digest ||
          bytes.length > DEPENDENCY_LIMITS.fileBytes ||
          this.bytes + bytes.length > DEPENDENCY_LIMITS.bytes
        )
          throw new RangeError("Unsupported captured snapshot bytes");
        const real = input.entry.canonicalPath;
        if (!contained(root, real))
          throw new TypeError("Invalid captured snapshot path");
        const entry: Entry = {
          probe: {
            kind: "file",
            path: identifier,
            digest: input.digest,
            realPath: `${name}:${relative(root, real).split(sep).join("/")}`,
          },
          text: input.text,
          bytes,
        };
        this.bytes += bytes.length;
        if (!this.retain(Buffer.byteLength(identifier) + 512))
          throw new RangeError("Snapshot capture capacity");
        this.entries.set(identifier, entry);
        return entry;
      }
    }
    let entry: Entry;
    let fallback: Entry | undefined;
    try {
      const link = lstatSync(absolute);
      const real = realpathSync(absolute);
      const metadata = statSync(real);
      const allowed = this.allowedRoot(real);
      if (metadata.isFile() && allowed !== undefined) {
        fallback = {
          probe: {
            kind: "file",
            path: identifier,
            digest: digest("uncached"),
            realPath: `${allowed[0]}:${relative(allowed[1]!, real).split(sep).join("/")}`,
          },
          passthrough: real,
        };
        if (
          metadata.size > DEPENDENCY_LIMITS.fileBytes ||
          this.bytes + metadata.size > DEPENDENCY_LIMITS.bytes
        ) {
          this.supported = false;
          if (this.snapshotOnly)
            throw new RangeError("Snapshot capture capacity");
          // Leave exceptional large reads to the analyzer, without retaining them.
          return fallback;
        }
        const fd = openSync(
          real,
          constants.O_RDONLY |
            (constants.O_NONBLOCK ?? 0) |
            (constants.O_NOFOLLOW ?? 0),
        );
        let buffer: Buffer;
        try {
          const before = fstatSync(fd);
          if (
            before.dev !== metadata.dev ||
            before.ino !== metadata.ino ||
            canonical(absolute) !== real
          )
            throw new Error("Changed dependency path");
          if (
            !before.isFile() ||
            before.size > DEPENDENCY_LIMITS.fileBytes ||
            this.bytes + before.size > DEPENDENCY_LIMITS.bytes
          )
            throw new RangeError("Dependency capture bound");
          buffer = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < buffer.length) {
            const count = readSync(
              fd,
              buffer,
              offset,
              buffer.length - offset,
              offset,
            );
            if (count === 0) throw new Error("Changed dependency input");
            offset += count;
          }
          const after = fstatSync(fd);
          if (
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            canonical(absolute) !== real
          )
            this.supported = false;
        } finally {
          closeSync(fd);
        }
        this.bytes += buffer.length;
        entry = {
          probe: {
            kind: "file",
            path: identifier,
            digest: digest(buffer),
            realPath: `${allowed[0]}:${relative(allowed[1]!, real).split(sep).join("/") || "."}`,
          },
          text: decode(this.snapshotOnly ? Buffer.from(buffer) : buffer),
          ...(this.snapshotOnly ? { bytes: buffer } : {}),
        };
      } else {
        entry = {
          probe: {
            kind: "entry",
            path: identifier,
            entryType: metadata.isDirectory() ? "directory" : "denied",
            identity: digest(
              `${this.snapshotOnly && contained(this.roots[identifier.split(":")[0]!] ?? "", real) ? this.identify(real) : real}:${link.isSymbolicLink()}:${metadata.isDirectory()}`,
            ),
          },
        };
      }
    } catch (error) {
      if (fallback !== undefined) {
        this.supported = false;
        if (this.snapshotOnly) throw error;
        return fallback;
      }
      // A dangling symlink is present, and cannot be serialized as absence.
      const code = (error as NodeJS.ErrnoException).code;
      let absent = false;
      if (code === "ENOENT" || code === "ENOTDIR") {
        try {
          lstatSync(absolute);
        } catch (missing) {
          absent = ["ENOENT", "ENOTDIR"].includes(
            (missing as NodeJS.ErrnoException).code ?? "",
          );
        }
      }
      if (absent) entry = { probe: { kind: "missing", path: identifier } };
      else {
        this.supported = false;
        entry = {
          probe: {
            kind: "entry",
            path: identifier,
            entryType: "denied",
            identity: digest("unsupported"),
          },
          unavailable: !existsSync(absolute),
        };
      }
    }
    if (
      this.retain(
        Buffer.byteLength(identifier) +
          512 +
          (entry.probe.kind === "file"
            ? Buffer.byteLength(entry.probe.realPath)
            : 0),
      )
    )
      this.entries.set(identifier, entry);
    return entry;
  }

  fileExists(path: string): boolean {
    return this.capture(path).probe.kind === "file";
  }
  /** Used by the snapshot-only Knip guard; links and denied entries are present. */
  assertMissing(path: string): void {
    if (this.capture(path).probe.kind !== "missing")
      throw new TypeError(
        "Dead-code dependency resolution escaped the snapshot",
      );
  }
  /** Exact captured bytes for the controlled Knip filesystem. Never passthrough. */
  readBytes(path: string, expectedCanonicalPath?: string): Buffer {
    if (!this.snapshotOnly) throw new TypeError("Snapshot capture required");
    const entry = this.capture(path);
    if (entry.bytes === undefined)
      throw new TypeError("Unavailable snapshot bytes");
    if (
      expectedCanonicalPath !== undefined &&
      (entry.probe.kind !== "file" ||
        entry.probe.realPath !== this.identify(expectedCanonicalPath))
    )
      throw new TypeError("Snapshot link changed during capture");
    return entry.bytes;
  }
  packageFileExists(path: string): boolean {
    const probe = this.capture(path).probe;
    return (
      probe.kind === "file" &&
      (probe.realPath.startsWith("packages:") ||
        (!this.snapshotOnly &&
          probe.realPath.startsWith("repository:") &&
          isInstalledDependencyPath(
            probe.realPath.slice("repository:".length),
          )))
    );
  }
  readFile(path: string): string | undefined {
    const entry = this.capture(path);
    if (entry.passthrough === undefined) return entry.text;
    let fd: number | undefined;
    try {
      const real = canonical(path);
      if (real === undefined || this.allowedRoot(real) === undefined)
        return undefined;
      const metadata = statSync(real);
      fd = openSync(
        real,
        constants.O_RDONLY |
          (constants.O_NONBLOCK ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== metadata.dev ||
        opened.ino !== metadata.ino ||
        canonical(path) !== real
      )
        return undefined;
      const bytes = readFileSync(fd);
      if (canonical(path) !== real) return undefined;
      return decode(bytes);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  directoryExists(path: string): boolean {
    const probe = this.capture(path).probe;
    return probe.kind === "entry" && probe.entryType === "directory";
  }
  /** Preserve the compiler's logical realpath behavior while observing link identity. */
  realpath(path: string): string {
    this.capture(path);
    return resolve(path);
  }
  directoryEntries(
    path: string,
  ): Extract<DependencyProbe, { kind: "directory" }>["names"] {
    const absolute = resolve(path);
    const identifier = this.capture(absolute).probe.path;
    const previous = this.listings.get(identifier);
    if (previous !== undefined) return previous.names;
    const captured = this.capture(absolute);
    const entry = captured.probe;
    if (entry.kind === "missing" || captured.unavailable === true) return [];
    if (entry.kind !== "entry" || entry.entryType !== "directory")
      throw new TypeError("Expected dependency directory");
    try {
      const names = readdirSync(absolute, { withFileTypes: true })
        .map((item) => ({
          name: item.name,
          type: item.isDirectory()
            ? ("directory" as const)
            : item.isFile()
              ? ("file" as const)
              : item.isSymbolicLink()
                ? ("symlink" as const)
                : ("other" as const),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      this.names += names.length;
      if (
        this.names > DEPENDENCY_LIMITS.names ||
        !this.retain(
          Buffer.byteLength(identifier) +
            256 +
            names.reduce(
              (bytes, item) => bytes + Buffer.byteLength(item.name) + 256,
              0,
            ),
        )
      ) {
        this.supported = false;
        return names;
      }
      const probe = {
        kind: "directory" as const,
        path: entry.path,
        identity: entry.identity,
        names: Object.freeze(names.map((name) => Object.freeze(name))),
      };
      this.listings.set(identifier, probe);
      return probe.names;
    } catch (error) {
      this.supported = false;
      throw error;
    }
  }
  getDirectories(path: string): string[] {
    try {
      return this.directoryEntries(path)
        .filter(
          (item) =>
            item.type === "directory" ||
            (item.type === "symlink" &&
              this.directoryExists(resolve(path, item.name))),
        )
        .map((item) => item.name);
    } catch {
      return [];
    }
  }
  manifest(): DependencyInputManifest | undefined {
    if (!this.supported) return undefined;
    try {
      return sanitizeDependencyInputManifest({
        version: 1,
        roots: this.rootsIdentity,
        probes: [
          ...[...this.entries.values()].map((entry) => entry.probe),
          ...this.listings.values(),
        ].sort((a, b) =>
          `${a.path}:${a.kind}` < `${b.path}:${b.kind}` ? -1 : 1,
        ),
      });
    } catch {
      this.supported = false;
      return undefined;
    }
  }
  private matches(manifest: DependencyInputManifest): boolean {
    try {
      const safe = sanitizeDependencyInputManifest(manifest);
      if (safe.roots !== this.rootsIdentity) return false;
      for (const probe of safe.probes) {
        const path = this.path(probe.path);
        if (probe.kind === "directory") this.directoryEntries(path);
        else this.capture(path);
      }
      return JSON.stringify(this.manifest()) === JSON.stringify(safe);
    } catch {
      return false;
    }
  }
  /** Always observe live inputs afresh, including when this view has been used. */
  validate(manifest: DependencyInputManifest): boolean {
    return CapturedDependencies.validate(
      manifest,
      this.context,
      this.snapshotOnly,
    );
  }
  static validate(
    manifest: DependencyInputManifest,
    context: DependencyCaptureContext,
    snapshotOnly: boolean | "knip" = false,
  ): boolean {
    return new CapturedDependencies(context, snapshotOnly, false).matches(
      manifest,
    );
  }
}

export function validateDependencyInputs(
  manifest: DependencyInputManifest | undefined,
  context: DependencyCaptureContext,
  snapshotOnly: boolean | "knip" = false,
): boolean {
  return (
    manifest !== undefined &&
    CapturedDependencies.validate(manifest, context, snapshotOnly)
  );
}
