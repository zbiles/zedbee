import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { diffChars } from "diff";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import { compareCodeUnits } from "../core/compare.js";
import { formatWorkingSource } from "./prettier-provider.js";
import {
  CommittedWriteError,
  writeWorkingFile,
  type WorkingFileIdentity,
  type WriteWorkingFileRequest,
} from "./write-working-file.js";
import type {
  CheckFixCandidate,
  ExactFixEdit,
  FixIssue,
  FixResult,
  FixableCheckId,
  PreparedFixPlan,
} from "./types.js";

export interface ApplyFixPlanDependencies {
  readWorkingFile?(repositoryRoot: string, file: string): Promise<string>;
  lstatWorkingFile?(
    repositoryRoot: string,
    file: string,
  ): Promise<WorkingFileIdentity>;
  writeWorkingFile?(request: WriteWorkingFileRequest): Promise<void>;
  formatWorkingSource?: typeof formatWorkingSource;
}

interface ExactEdit extends ExactFixEdit {
  readonly checkId: "lint" | "reactCorrectness";
}

interface FileCandidates {
  readonly file: string;
  readonly candidates: readonly CheckFixCandidate[];
}

function digest(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function issue(
  kind: FixIssue["kind"],
  file: string,
  checkIds: readonly FixableCheckId[],
  message: string,
  remediation: string,
): FixIssue {
  return Object.freeze({
    kind,
    file,
    checkIds: Object.freeze([...new Set(checkIds)].sort(compareCodeUnits)),
    message,
    remediation,
  });
}

function groupCandidates(
  candidates: readonly CheckFixCandidate[],
): readonly FileCandidates[] {
  const grouped = new Map<string, CheckFixCandidate[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.file);
    if (group === undefined) grouped.set(candidate.file, [candidate]);
    else group.push(candidate);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([file, groupedCandidates]) => ({
      file,
      candidates: groupedCandidates,
    }));
}

function checkIds(
  candidates: readonly CheckFixCandidate[],
): readonly FixableCheckId[] {
  return candidates.map((candidate) => candidate.checkId);
}

function overlaps(left: ExactFixEdit, right: ExactFixEdit): boolean {
  if (left.start === left.end && right.start === right.end) {
    return left.start === right.start;
  }
  if (left.start === left.end) {
    return left.start > right.start && left.start < right.end;
  }
  if (right.start === right.end) {
    return right.start > left.start && right.start < left.end;
  }
  return left.start < right.end && right.start < left.end;
}

function exactEdits(candidates: readonly CheckFixCandidate[]): {
  readonly baseSource: string | undefined;
  readonly edits: readonly ExactEdit[];
  readonly invalid: boolean;
} {
  const exact = candidates.filter(
    (candidate) => candidate.kind === "exact-file",
  );
  if (exact.length === 0)
    return { baseSource: undefined, edits: [], invalid: false };
  const baseSource = exact[0]!.baseSource;
  const edits = exact
    .flatMap((candidate) =>
      candidate.edits.map((edit) => ({ ...edit, checkId: candidate.checkId })),
    )
    .sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        compareCodeUnits(left.findingId, right.findingId),
    );
  const invalid =
    exact.some((candidate) => candidate.baseSource !== baseSource) ||
    edits.some((edit, index) => index > 0 && overlaps(edits[index - 1]!, edit));
  return { baseSource, edits, invalid };
}

/** Maps base UTF-16 offsets to current working UTF-16 offsets without text search. */
function composeExact(
  base: string,
  working: string,
  edits: readonly ExactEdit[],
): string | undefined {
  const baseToWorking = new Array<number>(base.length + 1);
  const baseCharacterToWorking = new Array<number>(base.length);
  let baseOffset = 0;
  let workingOffset = 0;
  baseToWorking[0] = 0;
  for (const component of diffChars(base, working)) {
    const length = component.value.length;
    if (component.added) {
      const intersects = edits.some((edit) =>
        edit.start === edit.end
          ? edit.start === baseOffset
          : edit.start < baseOffset && baseOffset < edit.end,
      );
      if (intersects) return undefined;
      workingOffset += length;
      continue;
    }
    if (component.removed) {
      const end = baseOffset + length;
      if (
        edits.some((edit) =>
          edit.start === edit.end
            ? baseOffset <= edit.start && edit.start <= end
            : edit.start < end && baseOffset < edit.end,
        )
      ) {
        return undefined;
      }
      baseOffset = end;
      continue;
    }
    for (let offset = 0; offset < length; offset += 1) {
      baseToWorking[baseOffset + offset] = workingOffset + offset;
      baseCharacterToWorking[baseOffset + offset] = workingOffset + offset;
    }
    baseOffset += length;
    workingOffset += length;
    baseToWorking[baseOffset] = workingOffset;
  }
  if (baseOffset !== base.length) return undefined;
  let merged = working;
  for (const edit of [...edits].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  )) {
    const start =
      edit.start === edit.end
        ? baseToWorking[edit.start]
        : baseCharacterToWorking[edit.start];
    const end =
      edit.start === edit.end
        ? start
        : (() => {
            const lastCharacter = baseCharacterToWorking[edit.end - 1];
            return lastCharacter === undefined ? undefined : lastCharacter + 1;
          })();
    if (start === undefined || end === undefined) return undefined;
    merged = `${merged.slice(0, start)}${edit.replacement}${merged.slice(end)}`;
  }
  return merged;
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function currentIdentity(
  root: string,
  file: string,
): Promise<WorkingFileIdentity> {
  const normalized = normalizeRepositoryRelativePath(file);
  const absolute = resolve(root, normalized);
  if (!contained(resolve(root), absolute))
    throw new Error("unsafe working-file path");
  const state = await lstat(absolute, { bigint: true });
  if (state.isSymbolicLink() || !state.isFile())
    throw new Error("unsafe working-file path");
  return { device: state.dev, inode: state.ino };
}

export async function applyFixPlan(
  plan: PreparedFixPlan,
  dependencies: ApplyFixPlanDependencies = {},
): Promise<FixResult> {
  const changedFiles: string[] = [];
  const unchangedFiles: string[] = [];
  const issues: FixIssue[] = [];
  let appliedFixes = 0;
  const read =
    dependencies.readWorkingFile ??
    ((root, file) => readFile(resolve(root, file), "utf8"));
  const stat = dependencies.lstatWorkingFile ?? currentIdentity;
  const write = dependencies.writeWorkingFile ?? writeWorkingFile;
  const format = dependencies.formatWorkingSource ?? formatWorkingSource;

  for (const group of groupCandidates(plan.candidates)) {
    const preview = plan.workingFiles.get(group.file);
    const ids = checkIds(group.candidates);
    if (preview === undefined) {
      unchangedFiles.push(group.file);
      issues.push(
        issue(
          "write",
          group.file,
          ids,
          "Zedbee could not find the working-file preview.",
          "Build a fresh fix plan and try again.",
        ),
      );
      continue;
    }
    let working: string;
    let identity: WorkingFileIdentity;
    try {
      working = await read(plan.repositoryRoot, group.file);
      identity = await stat(plan.repositoryRoot, group.file);
    } catch {
      unchangedFiles.push(group.file);
      issues.push(
        issue(
          "write",
          group.file,
          ids,
          "Zedbee could not safely read the working file.",
          "Inspect the file path and build a fresh fix plan.",
        ),
      );
      continue;
    }
    if (digest(working) !== preview.sha256) {
      unchangedFiles.push(group.file);
      issues.push(
        issue(
          "stale",
          group.file,
          ids,
          "The working file changed after Zedbee previewed it.",
          "Build a fresh fix plan and try again.",
        ),
      );
      continue;
    }
    const exact = exactEdits(group.candidates);
    if (exact.invalid) {
      unchangedFiles.push(group.file);
      issues.push(
        issue(
          "conflict",
          group.file,
          ids,
          "Zedbee found overlapping or incompatible exact fixes.",
          "Resolve the findings and build a fresh fix plan.",
        ),
      );
      continue;
    }
    let next = working;
    if (exact.baseSource !== undefined) {
      const composed = composeExact(exact.baseSource, working, exact.edits);
      if (composed === undefined) {
        unchangedFiles.push(group.file);
        issues.push(
          issue(
            "conflict",
            group.file,
            ids,
            "Working changes overlap a managed exact fix.",
            "Resolve the overlapping edit and build a fresh fix plan.",
          ),
        );
        continue;
      }
      next = composed;
    }
    const formatCandidate = group.candidates.find(
      (candidate) => candidate.kind === "format-file",
    );
    if (formatCandidate?.kind === "format-file") {
      try {
        next = await format({
          file: group.file,
          source: next,
          settings: formatCandidate.settings,
        });
      } catch {
        unchangedFiles.push(group.file);
        issues.push(
          issue(
            "format",
            group.file,
            ids,
            "Zedbee could not format the complete working file.",
            "Fix the formatting error and build a fresh fix plan.",
          ),
        );
        continue;
      }
    }
    if (next === working) {
      unchangedFiles.push(group.file);
      continue;
    }
    try {
      await write({
        repositoryRoot: plan.repositoryRoot,
        file: group.file,
        source: next,
        expectedIdentity: identity,
        expectedSha256: digest(working),
      });
      changedFiles.push(group.file);
      appliedFixes +=
        exact.edits.length + (formatCandidate === undefined ? 0 : 1);
    } catch (error) {
      if (error instanceof CommittedWriteError) {
        changedFiles.push(group.file);
        appliedFixes +=
          exact.edits.length + (formatCandidate === undefined ? 0 : 1);
        issues.push(
          issue(
            "write",
            group.file,
            ids,
            "The working file was replaced, but Zedbee could not confirm directory durability.",
            "Do not retry automatically; inspect the file and filesystem durability before continuing.",
          ),
        );
        continue;
      }
      unchangedFiles.push(group.file);
      issues.push(
        issue(
          "write",
          group.file,
          ids,
          "Zedbee could not safely write the working file.",
          "Inspect the file and build a fresh fix plan.",
        ),
      );
    }
  }

  return deepFreeze({
    exitCode: issues.length === 0 ? (0 as const) : (1 as const),
    appliedFixes,
    changedFiles: changedFiles.sort(compareCodeUnits),
    unchangedFiles: unchangedFiles.sort(compareCodeUnits),
    issues: issues.sort(
      (left, right) =>
        compareCodeUnits(left.file, right.file) ||
        compareCodeUnits(left.kind, right.kind),
    ),
  });
}
