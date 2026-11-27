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

// Read Git's original headers. parse-diff unquotes names and strips prefixes
// before exposing them, losing information needed to distinguish literal bytes.
function decodePatchName(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"')) return invalidPatch();
  const chunks: Buffer[] = [];
  const escaped: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  for (const token of raw
    .slice(1, -1)
    .match(/[^\\]+|\\[0-3][0-7]{2}|\\[\s\S]|\\$/gu) ?? []) {
    if (!token.startsWith("\\")) chunks.push(Buffer.from(token));
    else {
      const code =
        token.length === 4
          ? Number.parseInt(token.slice(1), 8)
          : escaped[token.slice(1)];
      if (code === undefined) return invalidPatch();
      chunks.push(Buffer.from([code]));
    }
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Buffer.concat(chunks),
  );
}

function patchNames(
  header: string,
  renamedFrom?: string,
  renamedTo?: string,
): readonly [string, string] {
  if (renamedFrom !== undefined && renamedTo !== undefined)
    return [decodePatchName(renamedFrom), decodePatchName(renamedTo)];
  // Non-renames always repeat the same name. Their midpoint is unambiguous,
  // even when a legitimate name itself contains " b/".
  const middle = (header.length - 1) / 2;
  let fields =
    Number.isInteger(middle) && header[middle] === " "
      ? [header.slice(0, middle), header.slice(middle + 1)]
      : undefined;
  if (!fields || !/^"?a\//u.test(fields[0]!) || !/^"?b\//u.test(fields[1]!)) {
    fields = /^(.*) ("?b\/.*)$/u.exec(header)?.slice(1);
  }
  if (!fields) return invalidPatch();
  const [left, right] = fields.map(decodePatchName);
  if (!left?.startsWith("a/") || !right?.startsWith("b/"))
    return invalidPatch();
  return [left.slice(2), right.slice(2)];
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

function toChangedFile(
  file: parseDiff.File,
  [from, to]: readonly [string, string],
): ChangedFile {
  if (file.deleted === true) {
    return { path: from, status: "deleted", addedRanges: [] };
  }
  if (file.new === true) {
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
  const headers = [
    ...patch.matchAll(
      /^diff --git ([^\n]*)(?:\n(?:old mode|new mode|similarity index|dissimilarity index) [^\n]*)*(?:\nrename from ([^\n]*)\nrename to ([^\n]*))?/gm,
    ),
  ];
  if (headers.length === 0 || headers.length !== files.length) {
    return invalidPatch();
  }
  const changedFiles = new Map<string, { file: ChangedFile; mode?: string }>();
  for (const [index, file] of files.entries()) {
    const header = headers[index]!;
    const changedFile = toChangedFile(
      file,
      patchNames(header[1]!, header[2], header[3]),
    );
    if (!validPatchFile(file)) return invalidPatch();
    const sectionStart = header.index! + header[0].length;
    const mode =
      /^\n(?:deleted file mode|new file mode) (100644|100755|120000|160000)(?:\n|$)/u.exec(
        patch.slice(sectionStart),
      )?.[1];
    const previous = changedFiles.get(changedFile.path);
    if (previous === undefined) {
      changedFiles.set(changedFile.path, {
        file: changedFile,
        ...(mode === undefined ? {} : { mode }),
      });
      continue;
    }
    // Git represents a change between file types as two complementary
    // sections at the same path. The modes distinguish it from duplicates.
    if (
      previous.file.status !== "deleted" ||
      changedFile.status !== "added" ||
      previous.mode === undefined ||
      mode === undefined ||
      previous.mode.slice(0, 2) === mode.slice(0, 2)
    )
      return invalidPatch();
    changedFiles.set(changedFile.path, {
      file: { ...changedFile, status: "modified" },
    });
  }

  return changeSetFromFiles([...changedFiles.values()].map(({ file }) => file));
}

function changeSetFromFiles(changedFiles: readonly ChangedFile[]): ChangeSet {
  const files = new Map(changedFiles.map((file) => [file.path, file]));
  const orderedFiles = new Map(
    [...files].sort(([left], [right]) => compareCodeUnits(left, right)),
  );

  return changeSetFromMap(orderedFiles);
}

export function changeSetFromMap(
  files: ReadonlyMap<string, ChangedFile>,
  isEmpty = files.size === 0,
): ChangeSet {
  return {
    files,
    isEmpty,
    containsAddedLine(file, line) {
      return (
        (
          files.get(file) ?? files.get(file.replaceAll("\\", "/"))
        )?.addedRanges.some(({ start, end }) => start <= line && line <= end) ??
        false
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
] as const;

const PATCH_ALGORITHM = [
  "--diff-algorithm=myers",
  "--indent-heuristic",
] as const;

const COMMIT_DIFF_OPTIONS = [
  ...COMMON_DIFF_OPTIONS,
  "--text",
  ...PATCH_ALGORITHM,
  "--find-renames=50%",
  "-l0",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;

const STAGED_DIFF_OPTIONS = [
  ...COMMON_DIFF_OPTIONS,
  ...PATCH_ALGORITHM,
  "--find-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;

const NAME_STATUS_DIFF_OPTIONS = [
  "--name-status",
  "-z",
  "--no-relative",
  "--ignore-submodules=none",
  "--submodule=short",
  "--no-ext-diff",
  "--no-textconv",
] as const;

export async function discoverStagedChangeSet(
  git: GitClient,
  signal?: AbortSignal,
): Promise<ChangeSet> {
  const metadata = await git.run(
    [
      "diff",
      "--cached",
      ...(git.selectedComparison === undefined
        ? []
        : [git.selectedComparison.diffBase]),
      ...NAME_STATUS_DIFF_OPTIONS,
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
      ...NAME_STATUS_DIFF_OPTIONS,
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

// Keep each rename's source and destination together. The conservative byte
// budget also leaves room for the fixed arguments and platform encoding.
const PATHSPEC_BYTE_BUDGET = (process.platform === "win32" ? 24 : 128) * 1024;

function* textTargetBatches(
  metadata: ChangeSet,
  excludedPaths: ReadonlySet<string>,
  byteBudget: number,
): Iterable<string[]> {
  let batch: string[] = [];
  let bytes = 0;
  for (const file of metadata.files.values()) {
    if (file.status === "deleted" || excludedPaths.has(file.path)) continue;
    const paths = [file.previousPath, file.path]
      .filter((path): path is string => path !== undefined)
      .map((path) => `:(literal)${path}`);
    const cost = paths.reduce(
      (size, path) => size + Buffer.byteLength(path) + 3,
      0,
    );
    if (batch.length && bytes + cost > byteBudget) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(...paths);
    bytes += cost;
  }
  if (batch.length) yield batch;
}

async function collectLineRanges(
  git: GitClient,
  metadata: ChangeSet,
  excludedPaths: ReadonlySet<string>,
  args: readonly string[],
  options: Parameters<GitClient["run"]>[1],
  byteBudget: number,
): Promise<ChangeSet> {
  const patches = new Map<string, ChangedFile>();
  for (const paths of textTargetBatches(metadata, excludedPaths, byteBudget)) {
    const patch = await git.run([...args, "--", ...paths], options);
    for (const [path, file] of changeSetFromPatch(patch.stdout).files) {
      if (patches.has(path)) return invalidPatch();
      patches.set(path, file);
    }
  }
  return applyAddedRanges(metadata, changeSetFromMap(patches));
}

export async function addStagedLineRanges(
  git: GitClient,
  metadata: ChangeSet,
  excludedPaths: ReadonlySet<string>,
  signal?: AbortSignal,
  byteBudget = PATHSPEC_BYTE_BUDGET,
): Promise<ChangeSet> {
  return collectLineRanges(
    git,
    metadata,
    excludedPaths,
    [
      "diff",
      "--cached",
      ...(git.selectedComparison === undefined
        ? []
        : [git.selectedComparison.diffBase]),
      ...STAGED_DIFF_OPTIONS,
      "--text",
    ],
    signal === undefined ? {} : { signal },
    byteBudget,
  );
}

export async function addCommitLineRanges(
  git: GitClient,
  metadata: ChangeSet,
  excludedPaths: ReadonlySet<string>,
  baselineCommit: string,
  targetCommit: string,
  signal?: AbortSignal,
  byteBudget = PATHSPEC_BYTE_BUDGET,
): Promise<ChangeSet> {
  return collectLineRanges(
    git,
    metadata,
    excludedPaths,
    ["diff", ...COMMIT_DIFF_OPTIONS, baselineCommit, targetCommit],
    {
      env: { GIT_ATTR_SOURCE: targetCommit },
      ...(signal === undefined ? {} : { signal }),
    },
    byteBudget,
  );
}

export async function readStagedChangeSet(
  git: GitClient,
  signal?: AbortSignal,
): Promise<ChangeSet> {
  const patch = await git.run(
    [
      "diff",
      "--cached",
      ...(git.selectedComparison === undefined
        ? []
        : [git.selectedComparison.diffBase]),
      ...STAGED_DIFF_OPTIONS,
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
      ...COMMIT_DIFF_OPTIONS,
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
