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
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { GitClient } from "../git/client.js";
import {
  buildSnapshotPair,
  SnapshotConstructionCleanupError,
  type SnapshotPair,
} from "../git/snapshot.js";
import { validateReportableSnapshotPath } from "../git/snapshot-path.js";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import { compareCodeUnits } from "../core/compare.js";
import { composeExactFixes, exactFixesOverlap } from "./exact-edits.js";
import { formatWorkingSource } from "./prettier-provider.js";
import type { FormattingFixSelection } from "../checks/prettier/project-types.js";
import {
  openProjectFormatter,
  resolveProjectPrettierInstallation,
  snapshotIdentity,
  type ProjectFormatterSession,
} from "../checks/prettier/project-engine.js";
import { requireProjectPrettierTrust } from "../checks/prettier/project-trust.js";
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
  /**
   * Parent-owned invocation-only consent for project Prettier, carried in
   * memory from the fix command; it is never serialized into the plan.
   */
  readonly projectPrettierTrust?: boolean;
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

class FixPlanStaleError extends Error {
  readonly kind = "stale";
}

class FixPlanIgnoredError extends Error {
  readonly kind = "ignored";
}

/** Cleanup failure carries source-free apply progress to command callers. */
export class FixApplyCleanupError extends AnalysisSessionCleanupError {
  readonly result?: FixResult;

  constructor(temporaryPath?: string, result?: FixResult, primary?: unknown) {
    super(
      temporaryPath,
      primary === undefined
        ? undefined
        : {
            cause: primary,
            primaryFailure: {
              code: "FIX_APPLY_FAILED",
              message: "Zedbee could not complete the managed fix.",
              remediation:
                "Review any applied changes before building a fresh fix plan.",
            },
          },
    );
    this.name = "FixApplyCleanupError";
    if (result !== undefined) this.result = result;
  }
}

/** One staged view and formatter per project, owned until all apply workers settle. */
class ProjectFixFormattingOwner {
  snapshot?: SnapshotPair;
  identity?: string;
  readonly sessions = new Map<string, ProjectFormatterSession>();
  cleanupFailed = false;
  temporaryPath: string | undefined;
  primaryFailure?: unknown;
  cleanupCause?: unknown;

  async stagedSnapshot(repositoryRoot: string, signal?: AbortSignal) {
    if (this.cleanupFailed && this.snapshot === undefined)
      throw this.primaryFailure;
    if (this.snapshot === undefined) {
      try {
        this.snapshot = await buildSnapshotPair(
          repositoryRoot,
          new GitClient(repositoryRoot),
          signal,
        );
        this.temporaryPath = dirname(this.snapshot.targetDir);
      } catch (error) {
        if (error instanceof SnapshotConstructionCleanupError) {
          this.cleanupFailed = true;
          this.temporaryPath = error.temporaryPath;
          this.primaryFailure ??= error.constructionError;
          throw error.constructionError;
        }
        throw error;
      }
    }
    this.identity ??= await snapshotIdentity(this.snapshot.targetDir);
    return this.snapshot;
  }

  async closeFormatters(): Promise<boolean> {
    let closed = true;
    for (const session of this.sessions.values()) {
      try {
        await session.close();
      } catch (error) {
        closed = false;
        this.cleanupFailed = true;
        this.cleanupCause ??= error;
      }
    }
    return closed;
  }

  async cleanupSnapshot(workersClosed: boolean): Promise<void> {
    if (this.snapshot === undefined) return;
    if (!workersClosed) {
      this.cleanupFailed = true;
      return;
    }
    try {
      await this.snapshot.cleanup();
    } catch (error) {
      this.cleanupFailed = true;
      this.cleanupCause ??= error;
    }
  }

  reportablePath(): string | undefined {
    try {
      return validateReportableSnapshotPath(this.temporaryPath ?? "");
    } catch {
      return undefined;
    }
  }
}

async function formatProjectWorkingFile(
  input: {
    readonly repositoryRoot: string;
    readonly file: string;
    readonly source: string;
    readonly selection: Extract<FormattingFixSelection, { engine: "project" }>;
    readonly signal?: AbortSignal;
    /** Invocation-only consent from the trusted parent, in memory only. */
    readonly projectPrettierTrust?: boolean;
  },
  owner: ProjectFixFormattingOwner,
): Promise<string> {
  // Configuration, helpers, and plugins stay pinned to this staged view;
  // only the explicit source bytes come from the current working file.
  const snapshot = await owner.stagedSnapshot(
    input.repositoryRoot,
    input.signal,
  );
  if (owner.identity !== input.selection.snapshotIdentity) {
    throw new FixPlanStaleError("The selected formatting snapshot changed.");
  }
  const installation = await resolveProjectPrettierInstallation(
    input.repositoryRoot,
    input.selection.projectRoot,
    snapshot.targetDir,
  );
  if (installation.identity !== input.selection.installationIdentity) {
    throw new FixPlanStaleError("The project Prettier installation changed.");
  }
  const permit = await requireProjectPrettierTrust(
    input.repositoryRoot,
    input.selection.projectRoot,
    input.projectPrettierTrust === true,
  );
  let session = owner.sessions.get(input.selection.projectRoot);
  if (session === undefined) {
    session = await openProjectFormatter({
      checkoutRoot: await realpath(input.repositoryRoot),
      snapshotRoot: snapshot.targetDir,
      projectRoot: input.selection.projectRoot,
      installation,
      permit,
      signal: input.signal ?? new AbortController().signal,
    });
    owner.sessions.set(input.selection.projectRoot, session);
  }
  const result = await session.format(input.file, input.source);
  if (result.kind === "ignored") {
    throw new FixPlanIgnoredError("The project formatter ignored the file.");
  }
  return result.text;
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

interface ApplyFixProgress {
  readonly changedFiles: string[];
  readonly unchangedFiles: string[];
  readonly issues: FixIssue[];
  appliedFixes: number;
}

function completedFixResult(
  progress: ApplyFixProgress,
  interrupted = false,
): FixResult {
  return deepFreeze({
    exitCode:
      progress.issues.length === 0 && !interrupted
        ? (0 as const)
        : (1 as const),
    appliedFixes: progress.appliedFixes,
    changedFiles: [...progress.changedFiles].sort(compareCodeUnits),
    unchangedFiles: [...progress.unchangedFiles].sort(compareCodeUnits),
    issues: [...progress.issues].sort(
      (left, right) =>
        compareCodeUnits(left.file, right.file) ||
        compareCodeUnits(left.kind, right.kind),
    ),
  });
}

export async function applyFixPlan(
  plan: PreparedFixPlan,
  dependencies: ApplyFixPlanDependencies = {},
): Promise<FixResult> {
  dependencies.signal?.throwIfAborted();
  const executor = dependencies.executor ?? createLocalAnalyzerExecutor();
  const formatting = new ProjectFixFormattingOwner();
  const progress: ApplyFixProgress = {
    changedFiles: [],
    unchangedFiles: [],
    issues: [],
    appliedFixes: 0,
  };
  let session: Awaited<ReturnType<AnalyzerExecutor["openSession"]>> | undefined;
  let primary: unknown;
  let failed = false;
  let result: FixResult | undefined;
  let workersClosed = false;
  let workerCleanupFailure: unknown;
  try {
    session = await executor.openSession();
    result = await withAnalyzerExecutionSession(session, () =>
      applyWithinSession(plan, dependencies, formatting, progress),
    );
  } catch (error) {
    primary = error;
    failed = true;
  } finally {
    workersClosed = await formatting.closeFormatters();
    try {
      await session?.close();
    } catch (error) {
      workersClosed = false;
      workerCleanupFailure ??= error;
    }
    if (dependencies.executor === undefined) {
      try {
        await executor.close();
      } catch (error) {
        workersClosed = false;
        workerCleanupFailure ??= error;
      }
    }
    await formatting.cleanupSnapshot(workersClosed);
  }
  // Cancellation can arrive while cleanup is settling. Keep its identity and
  // attach the safe cleanup diagnosis without losing a completed write result.
  if (!failed && dependencies.signal?.aborted) {
    primary = dependencies.signal.reason;
    failed = true;
  }
  if (formatting.cleanupFailed || !workersClosed) {
    const cleanup = new FixApplyCleanupError(
      formatting.reportablePath(),
      result ?? completedFixResult(progress, failed),
      failed
        ? primary
        : (formatting.primaryFailure ??
            formatting.cleanupCause ??
            workerCleanupFailure),
    );
    throw failed ? retainCleanupFailure(primary, cleanup) : cleanup;
  }
  if (failed) throw primary;
  return result!;
}

async function applyWithinSession(
  plan: PreparedFixPlan,
  dependencies: ApplyFixPlanDependencies,
  formatting: ProjectFixFormattingOwner,
  progress: ApplyFixProgress,
): Promise<FixResult> {
  dependencies.signal?.throwIfAborted();
  const { changedFiles, unchangedFiles, issues } = progress;
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
        if (formatCandidate.selection?.engine === "project") {
          next = await formatProjectWorkingFile(
            {
              repositoryRoot: plan.repositoryRoot,
              file: group.file,
              source: next,
              selection: formatCandidate.selection,
              ...(dependencies.signal === undefined
                ? {}
                : { signal: dependencies.signal }),
              ...(dependencies.projectPrettierTrust === true
                ? { projectPrettierTrust: true }
                : {}),
            },
            formatting,
          );
        } else {
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
        }
      } catch (error) {
        formatting.primaryFailure ??= error;
        dependencies.signal?.throwIfAborted();
        if (
          error instanceof AnalyzerJobError &&
          error.diagnostic.category === "cancellation"
        )
          throw error;
        unchangedFiles.push(group.file);
        if (error instanceof FixPlanStaleError) {
          issues.push(
            issue(
              "stale",
              group.file,
              ids,
              "The selected formatting engine or snapshot changed after the plan was built.",
              "Build a fresh fix plan and re-approve the changes.",
            ),
          );
        } else if (error instanceof FixPlanIgnoredError) {
          continue;
        } else {
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
        }
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
      progress.appliedFixes +=
        exact.edits.length + (formatCandidate === undefined ? 0 : 1);
    } catch (error) {
      if (error instanceof CommittedWriteError) {
        changedFiles.push(group.file);
        progress.appliedFixes +=
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
  return completedFixResult(progress);
}
