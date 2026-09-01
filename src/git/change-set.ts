import parseDiff from "parse-diff";
import type { GitClient } from "./client.js";
import { compareCodeUnits } from "../core/compare.js";

export interface LineRange {
  start: number;
  end: number;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  addedRanges: readonly LineRange[];
}

export interface ChangeSet {
  files: ReadonlyMap<string, ChangedFile>;
  isEmpty: boolean;
  containsAddedLine(file: string, line: number): boolean;
}

export function mergeLineRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = ranges
    .map((range) => ({ ...range }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: LineRange[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end + 1) {
      merged.push(range);
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }

  return merged;
}

function normalizePath(path: string | undefined): string | undefined {
  if (path === undefined || path === "/dev/null") {
    return undefined;
  }
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("a/") || normalized.startsWith("b/")
    ? normalized.slice(2)
    : normalized;
}

function addedRanges(file: parseDiff.File): LineRange[] {
  if (
    file.chunks.some((chunk) =>
      chunk.changes.some((change) => change.content.includes("\0")),
    )
  ) {
    return [];
  }
  return mergeLineRanges(
    file.chunks.flatMap((chunk) =>
      chunk.changes.flatMap((change) =>
        change.type === "add" ? [{ start: change.ln, end: change.ln }] : [],
      ),
    ),
  );
}

function toChangedFile(file: parseDiff.File): ChangedFile | undefined {
  const from = normalizePath(file.from);
  const to = normalizePath(file.to);

  if (file.deleted === true || to === undefined) {
    return from === undefined
      ? undefined
      : { path: from, status: "deleted", addedRanges: [] };
  }
  if (file.new === true || from === undefined) {
    return { path: to, status: "added", addedRanges: addedRanges(file) };
  }
  if (from !== to) {
    return {
      path: to,
      previousPath: from,
      status: "renamed",
      addedRanges: addedRanges(file),
    };
  }
  return { path: to, status: "modified", addedRanges: addedRanges(file) };
}

function invalidPatch(): never {
  throw new Error("Git returned invalid diff output.");
}

function validPatchFile(file: parseDiff.File): boolean {
  const from = normalizePath(file.from);
  const to = normalizePath(file.to);
  if (from === undefined && to === undefined) {
    return false;
  }
  return file.chunks.every((chunk) => {
    if (
      !Number.isInteger(chunk.oldStart) ||
      !Number.isInteger(chunk.oldLines) ||
      !Number.isInteger(chunk.newStart) ||
      !Number.isInteger(chunk.newLines) ||
      chunk.oldStart < 0 ||
      chunk.oldLines < 0 ||
      chunk.newStart < 0 ||
      chunk.newLines < 0
    ) {
      return false;
    }
    const changes = chunk.changes.filter(
      (change) => change.content !== "\\ No newline at end of file",
    );
    if (
      changes.some(
        (change) => change.type === "normal" && change.content === "",
      )
    ) {
      return false;
    }
    const oldLines = changes.filter(
      (change) => change.type === "normal" || change.type === "del",
    ).length;
    const newLines = changes.filter(
      (change) => change.type === "normal" || change.type === "add",
    ).length;
    return oldLines === chunk.oldLines && newLines === chunk.newLines;
  });
}

function changeSetFromPatch(patch: string): ChangeSet {
  if (patch === "") {
    return changeSetFromFiles([]);
  }

  let files: parseDiff.File[];
  try {
    files = parseDiff(patch);
  } catch {
    return invalidPatch();
  }
  const headers = patch.match(/^diff --git /gmu) ?? [];
  if (headers.length === 0 || headers.length !== files.length) {
    return invalidPatch();
  }
  const changedFiles = files
    .map((file) => {
      const changedFile = toChangedFile(file);
      if (changedFile === undefined || !validPatchFile(file)) {
        return invalidPatch();
      }
      return changedFile;
    })
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  if (
    new Set(changedFiles.map((file) => file.path)).size !== changedFiles.length
  ) {
    return invalidPatch();
  }

  return changeSetFromFiles(changedFiles);
}

function changeSetFromFiles(changedFiles: readonly ChangedFile[]): ChangeSet {
  const files = new Map(changedFiles.map((file) => [file.path, file]));
  const orderedFiles = new Map(
    [...files].sort(([left], [right]) => compareCodeUnits(left, right)),
  );

  return {
    files: orderedFiles,
    isEmpty: orderedFiles.size === 0,
    containsAddedLine(file, line) {
      const normalized = file.replaceAll("\\", "/");
      return (
        orderedFiles
          .get(normalized)
          ?.addedRanges.some(
            (range) => line >= range.start && line <= range.end,
          ) ?? false
      );
    },
  };
}

export async function readStagedChangeSet(
  git: GitClient,
  signal?: AbortSignal,
): Promise<ChangeSet> {
  const patch = await git.run(
    [
      "diff",
      "--cached",
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ],
    signal === undefined ? {} : { signal },
  );
  return changeSetFromPatch(patch.stdout);
}

export async function readCommitChangeSet(
  git: GitClient,
  baselineCommit: string,
  targetCommit: string,
  signal?: AbortSignal,
): Promise<ChangeSet> {
  const patch = await git.run(
    [
      "diff",
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--text",
      "--diff-algorithm=myers",
      "--indent-heuristic",
      "--find-renames=50%",
      "-l0",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--end-of-options",
      baselineCommit,
      targetCommit,
    ],
    {
      env: { GIT_ATTR_SOURCE: targetCommit },
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return changeSetFromPatch(patch.stdout);
}
