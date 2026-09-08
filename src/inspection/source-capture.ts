import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
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
        selection.paths.reduce((length, path) => length + path.length, 0),
      0,
    ) >
    4 * 1024 * 1024
  )
    return undefined;
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
