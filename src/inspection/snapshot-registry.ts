import type { BigIntStats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { RepositoryInspectionError } from "./types.js";
import { compareCodeUnits } from "../core/compare.js";

export const IGNORED_DIRECTORY_NAMES = [
  "node_modules",
  ".venv",
  ".git",
  ".zedbee",
  ".snapshot",
  ".snapshots",
  "generated",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
] as const;

export interface SnapshotIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface SnapshotRegistryEntry {
  readonly repositoryPath: string;
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly targetKind: "directory" | "file";
  readonly lexicalIdentity: SnapshotIdentity;
  readonly targetIdentity: SnapshotIdentity;
}

export interface SnapshotRegistry {
  readonly snapshotRoot: string;
  exact(repositoryPath: string): SnapshotRegistryEntry | undefined;
  resolve(repositoryPath: string): SnapshotRegistryEntry | undefined;
  entries(): readonly SnapshotRegistryEntry[];
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`))
  );
}

function unsafePath(): RepositoryInspectionError {
  return new RepositoryInspectionError(
    "UNSAFE_SNAPSHOT_PATH",
    "Zedbee refused a path outside the snapshot.",
  );
}

function invalidSnapshot(): RepositoryInspectionError {
  return new RepositoryInspectionError(
    "INVALID_SNAPSHOT_DATA",
    "Zedbee could not inventory repository snapshot data.",
  );
}

function identity(metadata: BigIntStats): SnapshotIdentity {
  return Object.freeze({ device: metadata.dev, inode: metadata.ino });
}

function metadataKind(metadata: BigIntStats): "directory" | "file" | undefined {
  if (metadata.isDirectory()) return "directory";
  if (metadata.isFile()) return "file";
  return undefined;
}

export async function captureSnapshotRegistry(
  snapshotRoot: string,
): Promise<SnapshotRegistry> {
  const exactEntries = new Map<string, SnapshotRegistryEntry>();
  const absoluteEntries = new Map<string, SnapshotRegistryEntry>();
  const capturedEntries: SnapshotRegistryEntry[] = [];

  const captureEntry = async (repositoryPath: string): Promise<void> => {
    const absolutePath =
      repositoryPath === "."
        ? snapshotRoot
        : resolve(snapshotRoot, repositoryPath);
    let lexicalMetadata: BigIntStats;
    let canonicalPath: string;
    let targetMetadata: BigIntStats;
    try {
      lexicalMetadata = await lstat(absolutePath, { bigint: true });
      canonicalPath = await realpath(absolutePath);
      if (!isContained(snapshotRoot, canonicalPath)) throw unsafePath();
      targetMetadata = await lstat(canonicalPath, { bigint: true });
    } catch (error) {
      if (error instanceof RepositoryInspectionError) throw error;
      throw invalidSnapshot();
    }
    const targetKind = metadataKind(targetMetadata);
    const kind = lexicalMetadata.isSymbolicLink()
      ? "symlink"
      : metadataKind(lexicalMetadata);
    if (targetKind === undefined || kind === undefined) return;

    const entry = Object.freeze({
      repositoryPath,
      absolutePath,
      canonicalPath,
      kind,
      targetKind,
      lexicalIdentity: identity(lexicalMetadata),
      targetIdentity: identity(targetMetadata),
    });
    exactEntries.set(repositoryPath, entry);
    absoluteEntries.set(absolutePath, entry);
    capturedEntries.push(entry);

    if (kind !== "directory") return;
    let children;
    try {
      children = await readdir(absolutePath, { withFileTypes: true });
    } catch {
      throw invalidSnapshot();
    }
    for (const child of children.sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    )) {
      if (
        IGNORED_DIRECTORY_NAMES.includes(
          child.name as (typeof IGNORED_DIRECTORY_NAMES)[number],
        )
      ) {
        continue;
      }
      const childPath =
        repositoryPath === "."
          ? child.name
          : posix.join(repositoryPath, child.name);
      await captureEntry(childPath);
    }
  };

  await captureEntry(".");
  for (const entry of capturedEntries) {
    if (entry.kind !== "symlink") continue;
    const registeredTarget = absoluteEntries.get(entry.canonicalPath);
    if (
      registeredTarget === undefined ||
      registeredTarget.kind === "symlink" ||
      registeredTarget.targetIdentity.device !== entry.targetIdentity.device ||
      registeredTarget.targetIdentity.inode !== entry.targetIdentity.inode
    ) {
      throw invalidSnapshot();
    }
  }
  const frozenEntries = Object.freeze([...capturedEntries]);

  const resolveEntry = (
    repositoryPath: string,
  ): SnapshotRegistryEntry | undefined => {
    const normalized = normalizePath(repositoryPath).replace(/^\.\//, "");
    const exact = exactEntries.get(normalized);
    if (exact !== undefined) return exact;
    const components = normalized.split("/");
    for (let index = components.length - 1; index > 0; index -= 1) {
      const prefix = components.slice(0, index).join("/");
      const link = exactEntries.get(prefix);
      if (link?.kind !== "symlink" || link.targetKind !== "directory") continue;
      const suffix = components.slice(index).join("/");
      const target = absoluteEntries.get(resolve(link.canonicalPath, suffix));
      if (target === undefined) return undefined;
      return Object.freeze({
        ...target,
        repositoryPath: normalized,
        absolutePath: resolve(snapshotRoot, normalized),
      });
    }
    return undefined;
  };

  return Object.freeze({
    snapshotRoot,
    exact: (repositoryPath: string) =>
      exactEntries.get(normalizePath(repositoryPath)),
    resolve: resolveEntry,
    entries: () => frozenEntries,
  });
}

export function identitiesMatch(
  metadata: BigIntStats,
  expected: SnapshotIdentity,
): boolean {
  return metadata.dev === expected.device && metadata.ino === expected.inode;
}
