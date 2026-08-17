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

export async function readStagedChangeSet(git: GitClient): Promise<ChangeSet> {
  const patch = await git.run([
    "diff",
    "--cached",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ]);
  const changedFiles = parseDiff(patch.stdout)
    .map(toChangedFile)
    .filter((file): file is ChangedFile => file !== undefined)
    .sort((left, right) => compareCodeUnits(left.path, right.path));
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
