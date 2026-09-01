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

function changeSetFromNameStatus(output: string): ChangeSet {
  if (output === "") return changeSetFromFiles([]);
  if (!output.endsWith("\0")) return invalidPatch();
  const fields = output.slice(0, -1).split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (status === undefined) return invalidPatch();
    if (/^R\d{1,3}$/u.test(status)) {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!previousPath || !path) return invalidPatch();
      files.push({
        path,
        previousPath,
        status: "renamed",
        addedRanges: [],
      });
      continue;
    }
    const path = fields[index++];
    if (!path) return invalidPatch();
    if (status === "A") {
      files.push({ path, status: "added", addedRanges: [] });
    } else if (status === "D") {
      files.push({ path, status: "deleted", addedRanges: [] });
    } else if (status === "M" || status === "T") {
      files.push({ path, status: "modified", addedRanges: [] });
    } else {
      return invalidPatch();
    }
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    return invalidPatch();
  }
  return changeSetFromFiles(files);
}

function applyAddedRanges(metadata: ChangeSet, patch: ChangeSet): ChangeSet {
  for (const path of patch.files.keys()) {
    if (!metadata.files.has(path)) return invalidPatch();
  }
  return changeSetFromFiles(
    [...metadata.files.values()].map((file) => ({
      ...file,
      addedRanges: patch.files.get(file.path)?.addedRanges ?? [],
    })),
  );
}

export function addWholeFileLineRanges(
  changeSet: ChangeSet,
  lineCounts: ReadonlyMap<string, number>,
): ChangeSet {
  for (const [path, count] of lineCounts) {
    if (
      !changeSet.files.has(path) ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      return invalidPatch();
    }
  }
  return changeSetFromFiles(
    [...changeSet.files.values()].map((file) => {
      const count = lineCounts.get(file.path);
      return count === undefined
        ? file
        : {
            ...file,
            addedRanges: count === 0 ? [] : [{ start: 1, end: count }],
          };
    }),
  );
}

const COMMON_DIFF_OPTIONS = [
  "--no-relative",
  "--ignore-submodules=none",
  "--submodule=short",
  "--unified=0",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--diff-algorithm=myers",
  "--indent-heuristic",
] as const;

const COMMIT_DIFF_OPTIONS = [
  ...COMMON_DIFF_OPTIONS,
  "--find-renames=50%",
  "-l0",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;

const STAGED_DIFF_OPTIONS = [
  ...COMMON_DIFF_OPTIONS,
  "--find-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;

export async function discoverStagedChangeSet(
  git: GitClient,
  signal?: AbortSignal,
): Promise<ChangeSet> {
  const metadata = await git.run(
    [
      "diff",
      "--cached",
      "--name-status",
      "-z",
      "--no-relative",
      "--ignore-submodules=none",
      "--submodule=short",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
    ],
    signal === undefined ? {} : { signal },
  );
  return changeSetFromNameStatus(metadata.stdout);
}

export async function discoverCommitChangeSet(
  git: GitClient,
  baselineCommit: string,
  targetCommit: string,
  signal?: AbortSignal,
): Promise<ChangeSet> {
  const metadata = await git.run(
    [
      "diff",
      "--name-status",
      "-z",
      "--no-relative",
      "--ignore-submodules=none",
      "--submodule=short",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames=50%",
      "-l0",
      "--end-of-options",
      baselineCommit,
      targetCommit,
    ],
    {
      env: { GIT_ATTR_SOURCE: targetCommit },
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return changeSetFromNameStatus(metadata.stdout);
}

function textTargets(
  metadata: ChangeSet,
  excludedPaths: ReadonlySet<string>,
): string[] {
  return [
    ...new Set(
      [...metadata.files.values()].flatMap((file) =>
        file.status === "deleted" || excludedPaths.has(file.path)
          ? []
          : file.previousPath === undefined
            ? [file.path]
            : [file.previousPath, file.path],
      ),
    ),
  ];
}

function literalPathspecs(paths: readonly string[]): string[] {
  return paths.map((path) => `:(literal)${path}`);
}

export async function addStagedLineRanges(
  git: GitClient,
  metadata: ChangeSet,
  excludedPaths: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<ChangeSet> {
  const paths = textTargets(metadata, excludedPaths);
  if (paths.length === 0) return metadata;
  const patch = await git.run(
    [
      "diff",
      "--cached",
      ...STAGED_DIFF_OPTIONS,
      "--text",
      "--",
      ...literalPathspecs(paths),
    ],
    signal === undefined ? {} : { signal },
  );
  return applyAddedRanges(metadata, changeSetFromPatch(patch.stdout));
}

export async function addCommitLineRanges(
  git: GitClient,
  metadata: ChangeSet,
  excludedPaths: ReadonlySet<string>,
  baselineCommit: string,
  targetCommit: string,
  signal?: AbortSignal,
): Promise<ChangeSet> {
  const paths = textTargets(metadata, excludedPaths);
  if (paths.length === 0) return metadata;
  const patch = await git.run(
    [
      "diff",
      ...COMMIT_DIFF_OPTIONS,
      "--text",
      baselineCommit,
      targetCommit,
      "--",
      ...literalPathspecs(paths),
    ],
    {
      env: { GIT_ATTR_SOURCE: targetCommit },
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return applyAddedRanges(metadata, changeSetFromPatch(patch.stdout));
}

export async function readStagedChangeSet(
  git: GitClient,
  signal?: AbortSignal,
): Promise<ChangeSet> {
  const patch = await git.run(
    [
      "diff",
      "--cached",
      "--no-relative",
      "--ignore-submodules=none",
      "--submodule=short",
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
      "--no-relative",
      "--ignore-submodules=none",
      "--submodule=short",
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
