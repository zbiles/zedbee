import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { compareCodeUnits } from "../core/compare.js";
import { readonlyMap } from "../core/immutable-map.js";
import type { GitClient } from "../git/client.js";
import { captureSnapshotRegistry } from "../inspection/snapshot-registry.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../inspection/read-json.js";
import type { CheckFixCandidate, WorkingFilePreview } from "./types.js";

export const WORKING_PREVIEW_CONCURRENCY = 8;
export const WORKING_PREVIEW_FILE_BYTES = 4 * 1024 * 1024;
export const WORKING_PREVIEW_TOTAL_BYTES = 64 * 1024 * 1024;
const STATUS_PATH_BYTES = 24 * 1024;

export interface WorkingPreviewDependencies {
  changedWorkingFiles?: typeof changedWorkingFiles;
  hasUnstagedChanges?(
    git: GitClient,
    file: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}

/** Compares captured working bytes with raw blobs from the selected index.
 * No worktree-aware Git operation is allowed here: even diff --no-textconv can
 * run clean filters while refreshing working-file content.
 */
export async function changedWorkingFiles(
  git: GitClient,
  previews: ReadonlyMap<string, WorkingFilePreview>,
  signal: AbortSignal,
): Promise<ReadonlySet<string>> {
  const entries = new Map<string, { objectId: string; mode: string }>();
  let batch: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const result = await git.run(
      [
        "ls-files",
        "--stage",
        "-z",
        "--",
        ...batch.map((file) => `:(literal)${file}`),
      ],
      { signal },
    );
    for (const record of result.stdout.split("\0")) {
      if (record === "") continue;
      const match =
        /^([0-7]{6}) ([\da-f]{40}|[\da-f]{64}) ([0-3])\t([\s\S]+)$/u.exec(
          record,
        );
      if (match === null || match[3] !== "0" || !previews.has(match[4]!)) {
        throw new Error("Zedbee could not read the selected-index file state.");
      }
      entries.set(match[4]!, { objectId: match[2]!, mode: match[1]! });
    }
    batch = [];
    bytes = 0;
  };
  for (const file of previews.keys()) {
    const size = Buffer.byteLength(file, "utf8") + 12;
    if (bytes + size > STATUS_PATH_BYTES) await flush();
    batch.push(file);
    bytes += size;
  }
  await flush();
  const changed = new Set<string>();
  const filesByObject = new Map<string, string[]>();
  for (const [file, preview] of previews) {
    const entry = entries.get(file);
    if (entry === undefined || !["100644", "100755"].includes(entry.mode)) {
      changed.add(file);
      continue;
    }
    if ((entry.mode === "100755") !== ((preview.mode & 0o111) !== 0))
      changed.add(file);
    const files = filesByObject.get(entry.objectId);
    if (files === undefined) filesByObject.set(entry.objectId, [file]);
    else files.push(file);
  }
  let stagedBytes = 0;
  await git.streamBlobs(
    [...filesByObject.keys()],
    async (blob) => {
      stagedBytes += blob.size;
      if (
        blob.size > WORKING_PREVIEW_FILE_BYTES ||
        stagedBytes > WORKING_PREVIEW_TOTAL_BYTES
      ) {
        throw new Error(
          "Zedbee working-file previews exceeded the source byte budget.",
        );
      }
      const digest = createHash("sha256");
      for await (const chunk of blob.chunks) {
        signal.throwIfAborted();
        digest.update(chunk);
      }
      const sha256 = digest.digest("hex");
      for (const file of filesByObject.get(blob.objectId) ?? []) {
        if (previews.get(file)!.sha256 !== sha256) changed.add(file);
      }
    },
    { signal },
  );
  return changed;
}

/** Stops scheduling after failure and owns every in-flight task until it settles. */
export async function mapPreviewFiles<T>(
  files: readonly string[],
  signal: AbortSignal,
  read: (file: string) => Promise<T>,
): Promise<readonly T[]> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const results = new Array<T>(files.length);
  const worker = async () => {
    while (!failed && next < files.length) {
      const index = next++;
      try {
        signal.throwIfAborted();
        results[index] = await read(files[index]!);
        signal.throwIfAborted();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.allSettled(
    Array.from(
      { length: Math.min(files.length, WORKING_PREVIEW_CONCURRENCY) },
      worker,
    ),
  );
  if (failed) throw failure;
  return results;
}

export async function workingFilePreviews(
  repositoryRoot: string,
  candidates: readonly CheckFixCandidate[],
  git: GitClient,
  signal: AbortSignal,
  dependencies: WorkingPreviewDependencies,
): Promise<ReadonlyMap<string, WorkingFilePreview>> {
  const files = [
    ...new Set(candidates.map((candidate) => candidate.file)),
  ].sort(compareCodeUnits);
  if (files.length === 0) return readonlyMap([]);
  signal.throwIfAborted();
  const registry = await captureSnapshotRegistry(
    await canonicalizeSnapshotRoot(repositoryRoot),
    files,
  );
  let reservedBytes = 0;
  const previews = await mapPreviewFiles(files, signal, async (file) => {
    const entry = registry.exact(file);
    if (entry?.kind !== "file" || entry.targetKind !== "file")
      throw new TypeError("Zedbee refused an unsafe working-file path.");
    const metadata = await lstat(entry.canonicalPath);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new TypeError("Zedbee refused an unsafe working-file path.");
    if (
      metadata.size > WORKING_PREVIEW_FILE_BYTES ||
      reservedBytes + metadata.size > WORKING_PREVIEW_TOTAL_BYTES
    ) {
      throw new Error(
        "Zedbee working-file previews exceeded the source byte budget.",
      );
    }
    // Reserve before reading, and reject growth beyond the reserved size.
    reservedBytes += metadata.size;
    const content = await readContainedFile(registry, file, {
      maxBytes: metadata.size,
    });
    signal.throwIfAborted();
    const preview: WorkingFilePreview = Object.freeze({
      path: file,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      content,
      mode: metadata.mode & 0o777,
      hasUnstagedChanges:
        dependencies.changedWorkingFiles === undefined &&
        dependencies.hasUnstagedChanges !== undefined
          ? await dependencies.hasUnstagedChanges(git, file, signal)
          : false,
    });
    return [file, preview] as const;
  });
  const captured = readonlyMap(previews);
  const status =
    dependencies.changedWorkingFiles ??
    (dependencies.hasUnstagedChanges === undefined
      ? changedWorkingFiles
      : undefined);
  if (status === undefined) return captured;
  const changed = await status(git, captured, signal);
  return readonlyMap(
    previews.map(
      ([file, preview]) =>
        [
          file,
          Object.freeze({ ...preview, hasUnstagedChanges: changed.has(file) }),
        ] as const,
    ),
  );
}
