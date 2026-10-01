import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { compareCodeUnits } from "../core/compare.js";
import { GitClient } from "../git/client.js";
import { isContainedPath } from "./read-json.js";
import { RepositoryInspectionError } from "./types.js";
import {
  captureSnapshotRegistry,
  IGNORED_DIRECTORY_NAMES,
  type SnapshotRegistry,
} from "./snapshot-registry.js";

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    await lstat(join(directory, ".git"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Inventory live repository files, excluding ignored files and nested checkouts. */
export async function captureWorkingTreeRegistry(
  repositoryRoot: string,
): Promise<SnapshotRegistry> {
  const canonicalRoot = await realpath(repositoryRoot);
  // Inspection fixtures and unpacked projects need no Git metadata. Keep the
  // immutable snapshot inventory's behavior for these callers.
  if (!(await hasGitMarker(canonicalRoot)))
    return captureSnapshotRegistry(canonicalRoot);

  const git = new GitClient(canonicalRoot);
  const { stdout } = await git.run([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const paths: string[] = [];
  const boundaryCache = new Map<string, boolean>();
  for (const path of [...new Set(stdout.split("\0").filter(Boolean))].sort(
    compareCodeUnits,
  )) {
    const components = path.split("/");
    if (
      components.some((part) =>
        IGNORED_DIRECTORY_NAMES.includes(
          part as (typeof IGNORED_DIRECTORY_NAMES)[number],
        ),
      )
    )
      continue;
    let nested = false;
    // Include the final component: Git lists submodule/gitlink directories too.
    for (let index = 1; index <= components.length; index += 1) {
      const prefix = components.slice(0, index).join("/");
      let boundary = boundaryCache.get(prefix);
      if (boundary === undefined) {
        try {
          const directory = join(canonicalRoot, prefix);
          const metadata = await lstat(directory);
          // A link is not a nested repository boundary. Validate its real
          // target below, including rejecting links outside the repository.
          if (metadata.isSymbolicLink()) break;
          boundary = metadata.isDirectory() && (await hasGitMarker(directory));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOTDIR" && code !== "ENOENT") throw error;
          boundary = false;
        }
        boundaryCache.set(prefix, boundary);
      }
      if (boundary) {
        nested = true;
        break;
      }
    }
    if (!nested) paths.push(path);
  }
  // The snapshot registry also inventories symlink targets. Only let it see
  // links whose real target is part of this working-tree selection, otherwise
  // an alias could reintroduce an ignored or nested checkout's manifest.
  const selectedPaths = new Set(["."]);
  for (const path of paths) {
    const components = path.split("/");
    for (let index = 1; index <= components.length; index += 1)
      selectedPaths.add(components.slice(0, index).join("/"));
  }
  const containedPaths: string[] = [];
  for (const path of paths) {
    let target: string;
    try {
      target = await realpath(join(canonicalRoot, path));
    } catch (error) {
      // Deleted index entries should not become live project candidates.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!isContainedPath(canonicalRoot, target))
      throw new RepositoryInspectionError(
        "UNSAFE_SNAPSHOT_PATH",
        "Zedbee refused a path outside the snapshot.",
      );
    const targetPath =
      relative(canonicalRoot, target).split(sep).join("/") || ".";
    if (selectedPaths.has(targetPath)) containedPaths.push(path);
  }
  return captureSnapshotRegistry(canonicalRoot, containedPaths);
}
