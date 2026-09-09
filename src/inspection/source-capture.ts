import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  canonicalizeSnapshotRoot,
  ContainedFileSizeError,
  readContainedBytes,
} from "./read-json.js";
import {
  captureSnapshotRegistry,
  type SnapshotRegistry,
  type SnapshotRegistryEntry,
} from "./snapshot-registry.js";

export interface AnalysisSourceCapture {
  close(): Promise<void>;
}
export interface AnalysisSourceSelection {
  readonly snapshotRoot: string;
  readonly paths: readonly string[];
}

export interface CapturedSourceInput {
  readonly entry: SnapshotRegistryEntry | undefined;
  readonly text: string | undefined;
  readonly byteLength: number;
  readonly digest: string | undefined;
}

interface RootInput {
  readonly registry: SnapshotRegistry;
  readonly files: Map<string, CapturedSourceInput>;
}

class Capture implements AnalysisSourceCapture {
  closed = false;
  readonly roots = new Map<string, RootInput>();
  async close(): Promise<void> {
    this.closed = true;
    for (const root of this.roots.values()) root.files.clear();
    this.roots.clear();
  }
}
const current = new AsyncLocalStorage<Capture>();

/** Acquire a new immutable view, even when called inside an older view.
 * A capacity bypass returns no partial owner. Ordinary trust/read errors reject.
 */
export async function captureAnalysisSources(
  selections: readonly AnalysisSourceSelection[],
): Promise<AnalysisSourceCapture | undefined> {
  if (
    !Array.isArray(selections) ||
    selections.some(
      (selection) =>
        !selection ||
        typeof selection.snapshotRoot !== "string" ||
        !Array.isArray(selection.paths) ||
        selection.paths.some((path: unknown) => typeof path !== "string") ||
        Object.keys(selection).some(
          (key) => !["snapshotRoot", "paths"].includes(key),
        ),
    )
  )
    throw new TypeError("Invalid source selections.");
  if (
    selections.length > 20_000 ||
    selections.reduce((sum, selection) => sum + selection.paths.length, 0) >
      20_000
  )
    return undefined;
  if (
    selections.reduce(
      (sum, selection) =>
        sum +
        selection.snapshotRoot.length +
        selection.paths.reduce(
          (length: number, path: string) => length + path.length,
          0,
        ),
      0,
    ) >
    4 * 1024 * 1024
  )
    return undefined;
  selections = selections.map((selection) => ({
    snapshotRoot: selection.snapshotRoot,
    paths: [...selection.paths],
  }));
  const grouped = new Map<
    string,
    { paths: Set<string>; aliases: Set<string> }
  >();
  for (const selection of selections) {
    const root = await canonicalizeSnapshotRoot(selection.snapshotRoot);
    let group = grouped.get(root);
    if (group === undefined) {
      group = { paths: new Set(), aliases: new Set([root]) };
      grouped.set(root, group);
    }
    group.aliases.add(resolve(selection.snapshotRoot));
    for (const path of selection.paths) group.paths.add(path);
  }
  const owner = new Capture();
  let acquired = false;
  let totalBytes = 0;
  try {
    for (const [root, group] of grouped) {
      const registry = await captureSnapshotRegistry(root, [...group.paths]);
      const input: RootInput = { registry, files: new Map() };
      for (const alias of group.aliases) owner.roots.set(alias, input);
      for (const path of group.paths) {
        const entry = registry.resolve(path);
        let text: string | undefined;
        let digest: string | undefined;
        let byteLength = 0;
        if (entry?.targetKind === "file") {
          // This raw checked read deliberately does not consult the active view.
          const bytes = await readContainedBytes(registry, path, {
            maxBytes: Math.min(8 * 1024 * 1024, 32 * 1024 * 1024 - totalBytes),
          });
          byteLength = bytes.length;
          totalBytes += byteLength;
          text = bytes.toString("utf8");
          digest = createHash("sha256").update(bytes).digest("hex");
        }
        input.files.set(
          path,
          Object.freeze({ entry, text, byteLength, digest }),
        );
      }
    }
    acquired = true;
    return owner;
  } catch (error) {
    if (error instanceof ContainedFileSizeError) return undefined;
    throw error;
  } finally {
    if (!acquired) await owner.close();
  }
}

export async function withAnalysisSourceCapture<T>(
  capture: AnalysisSourceCapture,
  run: () => Promise<T>,
): Promise<T> {
  if (!(capture instanceof Capture))
    throw new TypeError("Invalid source capture owner.");
  if (capture.closed) throw new Error("Source capture is closed.");
  return current.run(capture, async () => {
    const result = await run();
    if (capture.closed) throw new Error("Source capture is closed.");
    return result;
  });
}

function activeRoot(root: string): RootInput | undefined {
  const owner = current.getStore();
  if (owner?.closed) throw new Error("Source capture is closed.");
  return owner?.roots.get(resolve(root));
}

/** Undefined means unselected; a selected missing entry is a captured absence. */
export function capturedSourceInput(
  root: string,
  path: string,
): CapturedSourceInput | undefined {
  return activeRoot(root)?.files.get(path);
}

/** Never substitute a partial view for a whole-tree or unselected inventory. */
export function capturedSourceRegistry(
  root: string,
  paths: readonly string[],
): SnapshotRegistry | undefined {
  const input = activeRoot(root);
  return input !== undefined && paths.every((path) => input.files.has(path))
    ? input.registry
    : undefined;
}

/** Selected logical paths only, never a replacement for a complete inventory. */
export function capturedSourcePaths(root: string): readonly string[] {
  return Object.freeze([...(activeRoot(root)?.files.keys() ?? [])]);
}

export function hasAnalysisSourceCapture(): boolean {
  const owner = current.getStore();
  if (owner?.closed) throw new Error("Source capture is closed.");
  return owner !== undefined;
}

/** Fixed nested analyzer workers inherit only the existing trusted capture. */
export function exportCurrentAnalysisSourceCapture():
  AnalysisSourceCaptureTransport | undefined {
  const owner = current.getStore();
  return owner === undefined ? undefined : exportAnalysisSourceCapture(owner);
}

/** Internal trusted-owner IPC only. Service clients send selections, never this. */
export interface AnalysisSourceCaptureTransport {
  readonly version: 1;
  readonly roots: readonly {
    readonly aliases: readonly string[];
    readonly snapshotRoot: string;
    readonly entries: readonly SnapshotRegistryEntry[];
    readonly files: readonly (readonly [string, CapturedSourceInput])[];
  }[];
}

function fields(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

/** A transport capacity bypass releases the caller's ordinary capture too. */
export function exportAnalysisSourceCapture(
  capture: AnalysisSourceCapture,
): AnalysisSourceCaptureTransport | undefined {
  if (!(capture instanceof Capture) || capture.closed)
    throw new TypeError("Invalid source capture owner.");
  const groups = new Map<RootInput, string[]>();
  for (const [alias, root] of capture.roots) {
    const aliases = groups.get(root) ?? [];
    aliases.push(alias);
    groups.set(root, aliases);
  }
  const value: AnalysisSourceCaptureTransport = {
    version: 1,
    roots: [...groups].map(([root, aliases]) => ({
      aliases,
      snapshotRoot: root.registry.snapshotRoot,
      entries: root.registry.entries(),
      files: [...root.files],
    })),
  };
  try {
    validateSourceTransport(value);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
  return value;
}

function validateSourceTransport(
  value: unknown,
): asserts value is AnalysisSourceCaptureTransport {
  const invalid = () => {
    throw new TypeError("Invalid source capture transport.");
  };
  if (
    !fields(value, ["version", "roots"]) ||
    value.version !== 1 ||
    !Array.isArray(value.roots)
  )
    return invalid();
  let metadataUnits = 0,
    rawBytes = 0,
    selections = 0,
    entries = 0;
  const string = (item: unknown): item is string => {
    if (typeof item !== "string" || item.includes("\0")) return false;
    metadataUnits += item.length;
    if (metadataUnits > 16 * 1024 * 1024)
      throw new RangeError("Source transport capacity.");
    return true;
  };
  const identity = (item: unknown) =>
    fields(item, ["device", "inode"]) &&
    typeof item.device === "bigint" &&
    typeof item.inode === "bigint" &&
    item.device >= 0n &&
    item.device <= 0xffffffffffffffffn &&
    item.inode >= 0n &&
    item.inode <= 0xffffffffffffffffn;
  const contained = (root: string, path: string) => {
    const from = relative(root, path);
    return !isAbsolute(from) && from !== ".." && !from.startsWith(`..${sep}`);
  };
  const entry = (
    item: unknown,
    root: string,
  ): item is SnapshotRegistryEntry => {
    if (
      !fields(item, [
        "repositoryPath",
        "absolutePath",
        "canonicalPath",
        "kind",
        "targetKind",
        "lexicalIdentity",
        "targetIdentity",
      ]) ||
      !string(item.repositoryPath) ||
      !string(item.absolutePath) ||
      !string(item.canonicalPath)
    )
      return false;
    return (
      (item.repositoryPath === "." ||
        (!item.repositoryPath.includes("\\") &&
          item.repositoryPath
            .split("/")
            .every((part) => part !== "" && part !== "." && part !== ".."))) &&
      ["directory", "file", "symlink"].includes(item.kind as string) &&
      ["directory", "file"].includes(item.targetKind as string) &&
      identity(item.lexicalIdentity) &&
      identity(item.targetIdentity) &&
      isAbsolute(item.absolutePath) &&
      isAbsolute(item.canonicalPath) &&
      contained(root, item.absolutePath) &&
      contained(root, item.canonicalPath) &&
      resolve(root, item.repositoryPath) === item.absolutePath
    );
  };
  if (value.roots.length > 20_000)
    throw new RangeError("Source transport capacity.");
  const aliases = new Set<string>();
  for (const root of value.roots) {
    if (
      !fields(root, ["aliases", "snapshotRoot", "entries", "files"]) ||
      !string(root.snapshotRoot) ||
      !isAbsolute(root.snapshotRoot) ||
      !Array.isArray(root.aliases) ||
      !Array.isArray(root.entries) ||
      !Array.isArray(root.files)
    )
      return invalid();
    if (
      root.aliases.length > 20_000 ||
      (entries += root.entries.length) > 40_000 ||
      (selections += root.files.length) > 20_000
    )
      throw new RangeError("Source transport capacity.");
    for (const alias of root.aliases) {
      if (!string(alias) || !isAbsolute(alias) || aliases.has(alias))
        return invalid();
      aliases.add(alias);
    }
    if (!root.aliases.includes(root.snapshotRoot)) return invalid();
    const paths = new Set<string>();
    const entryPaths = new Set<string>();
    for (const item of root.entries) {
      if (
        !entry(item, root.snapshotRoot) ||
        entryPaths.has(item.repositoryPath)
      )
        return invalid();
      entryPaths.add(item.repositoryPath);
    }
    if (!entryPaths.has(".")) return invalid();
    for (const pair of root.files) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !string(pair[0]) ||
        paths.has(pair[0]) ||
        !fields(pair[1], ["entry", "text", "byteLength", "digest"])
      )
        return invalid();
      const [path, file] = pair;
      if (
        path.length === 0 ||
        path.includes("\\") ||
        path
          .split("/")
          .some(
            (part: string) => part === "" || part === "." || part === "..",
          ) ||
        !contained(root.snapshotRoot, resolve(root.snapshotRoot, path))
      )
        return invalid();
      paths.add(path);
      if (
        typeof file.byteLength !== "number" ||
        !Number.isSafeInteger(file.byteLength) ||
        file.byteLength < 0 ||
        file.byteLength > 8 * 1024 * 1024
      )
        return invalid();
      rawBytes += file.byteLength;
      if (rawBytes > 32 * 1024 * 1024)
        throw new RangeError("Source transport capacity.");
      if (
        file.entry !== undefined &&
        (!entry(file.entry, root.snapshotRoot) ||
          file.entry.repositoryPath !== path)
      )
        return invalid();
      if (file.entry?.targetKind === "file") {
        if (
          typeof file.text !== "string" ||
          file.text.length > file.byteLength ||
          typeof file.digest !== "string" ||
          !/^[a-f0-9]{64}$/u.test(file.digest)
        )
          return invalid();
      } else if (
        file.text !== undefined ||
        file.digest !== undefined ||
        file.byteLength !== 0
      )
        return invalid();
    }
  }
}

export function importAnalysisSourceCapture(
  value: unknown,
): AnalysisSourceCapture {
  validateSourceTransport(value);
  const owner = new Capture();
  const copyEntry = (entry: SnapshotRegistryEntry): SnapshotRegistryEntry =>
    Object.freeze({
      ...entry,
      lexicalIdentity: Object.freeze({ ...entry.lexicalIdentity }),
      targetIdentity: Object.freeze({ ...entry.targetIdentity }),
    });
  for (const root of value.roots) {
    const files = new Map(
      root.files.map(([path, input]) => [
        path,
        Object.freeze({
          ...input,
          entry: input.entry === undefined ? undefined : copyEntry(input.entry),
        }),
      ]),
    );
    const entries = Object.freeze(root.entries.map(copyEntry));
    const exact = new Map(entries.map((item) => [item.repositoryPath, item]));
    const registry: SnapshotRegistry = Object.freeze({
      snapshotRoot: root.snapshotRoot,
      exact: (path: string) => exact.get(path.split(sep).join("/")),
      resolve: (path: string) => {
        const normalized = path.split(sep).join("/").replace(/^\.\//u, "");
        return files.get(normalized)?.entry ?? exact.get(normalized);
      },
      entries: () => entries,
    });
    const input = { files, registry };
    for (const alias of root.aliases) owner.roots.set(alias, input);
  }
  return owner;
}
