import { createHash } from "node:crypto";
import {
  createLocalAnalyzerExecutor,
  type AnalyzerExecutor,
} from "../checks/runner/executor.js";
import { withAnalyzerExecutionSession } from "../checks/runner/session.js";
import {
  AnalysisSessionCleanupError,
  retainCleanupFailure,
} from "../scan/analysis-failure.js";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import { compareCodeUnits } from "../core/compare.js";
import { composeExactFixes, exactFixesOverlap } from "./exact-edits.js";
import { formatWorkingSource } from "./prettier-provider.js";
import {
  AnalyzerJobError,
  sanitizeAnalyzerDiagnostic,
  type AnalyzerDiagnostic,
} from "../checks/diagnostics.js";
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
  readonly executor?: AnalyzerExecutor;
  readonly signal?: AbortSignal;
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
  diagnostic?: AnalyzerDiagnostic,
): FixIssue {
  return Object.freeze({
    kind,
    ...(diagnostic === undefined
      ? {}
      : { diagnostic: sanitizeAnalyzerDiagnostic(diagnostic) }),
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
    edits.some(
      (edit, index) => index > 0 && exactFixesOverlap(edits[index - 1]!, edit),
    );
  return { baseSource, edits, invalid };
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
  dependencies.signal?.throwIfAborted();
  const executor = dependencies.executor ?? createLocalAnalyzerExecutor();
  let session: Awaited<ReturnType<AnalyzerExecutor["openSession"]>> | undefined;
  let primary: unknown;
  try {
    session = await executor.openSession();
    return await withAnalyzerExecutionSession(session, () =>
      applyWithinSession(plan, dependencies),
    );
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    let cleanupFailed = false;
    try {
      await session?.close();
    } catch {
      cleanupFailed = true;
    }
    if (dependencies.executor === undefined) {
      try {
        await executor.close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      const cleanup = new AnalysisSessionCleanupError();
      throw primary === undefined
        ? cleanup
        : retainCleanupFailure(primary, cleanup);
    }
  }
}

async function applyWithinSession(
  plan: PreparedFixPlan,
  dependencies: ApplyFixPlanDependencies,
): Promise<FixResult> {
  dependencies.signal?.throwIfAborted();
  const changedFiles: string[] = [];
  const unchangedFiles: string[] = [];
  const issues: FixIssue[] = [];
  let appliedFixes = 0;
  for (const item of plan.publicPlan.items) {
    if (item.status !== "skipped") continue;
    issues.push(
      issue(
        "conflict",
        item.file,
        [item.checkId],
        item.reason ?? "Zedbee skipped a managed exact fix.",
        "Resolve the overlapping edit and build a fresh fix plan.",
      ),
    );
  }
  for (const file of plan.publicPlan.files) {
    if ((file.skippedFixes ?? 0) > 0 && (file.applicableFixes ?? 0) === 0) {
      unchangedFiles.push(file.path);
    }
  }
  const read =
    dependencies.readWorkingFile ??
    ((root, file) => readFile(resolve(root, file), "utf8"));
  const stat = dependencies.lstatWorkingFile ?? currentIdentity;
  const write = dependencies.writeWorkingFile ?? writeWorkingFile;
  const format = dependencies.formatWorkingSource ?? formatWorkingSource;

  for (const group of groupCandidates(plan.candidates)) {
    dependencies.signal?.throwIfAborted();
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
      dependencies.signal?.throwIfAborted();
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
      const composed = composeExactFixes(
        exact.baseSource,
        working,
        exact.edits,
      );
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
        next = await format(
          {
            file: group.file,
            source: next,
            settings: formatCandidate.settings,
          },
          dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal },
        );
      } catch (error) {
        dependencies.signal?.throwIfAborted();
        if (
          error instanceof AnalyzerJobError &&
          error.diagnostic.category === "cancellation"
        )
          throw error;
        unchangedFiles.push(group.file);
        issues.push(
          issue(
            "format",
            group.file,
            ids,
            "Zedbee could not format the complete working file.",
            "Fix the formatting error and build a fresh fix plan.",
            error instanceof AnalyzerJobError ? error.diagnostic : undefined,
          ),
        );
        continue;
      }
    }
    dependencies.signal?.throwIfAborted();
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

  dependencies.signal?.throwIfAborted();
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
