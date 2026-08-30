import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import type { CheckAdapter, CheckExecutionResult } from "../checks/adapter.js";
import { dispatchChecks } from "../checks/dispatcher.js";
import type { FilePolicyResolver } from "../config/file-policy.js";
import { loadConfig } from "../config/load-config.js";
import type { ResolvedConfig } from "../config/schema.js";
import { compareCodeUnits } from "../core/compare.js";
import type { ChangeSet } from "../git/change-set.js";
import { readStagedChangeSet } from "../git/change-set.js";
import { GitClient } from "../git/client.js";
import { buildSnapshotPair, type SnapshotPair } from "../git/snapshot.js";
import { validateReportableSnapshotPath } from "../git/snapshot-path.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import { captureSnapshotRegistry } from "../inspection/snapshot-registry.js";
import type { RepositoryInspection } from "../inspection/types.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../inspection/read-json.js";
import { evaluatePolicy, type PolicyDecision } from "../policy/evaluate.js";
import { parseTemporaryReportMaxAge } from "../reporting/report-age.js";
import { unsupportedEntryFailures } from "../scan/unsupported-inputs.js";
import { DEFAULT_CHECK_ADAPTERS } from "../scan/run-scan.js";
import { prettierParserFor } from "../checks/prettier/supported-path.js";
import { sanitizeFixCandidates } from "./sanitize.js";
import { composeExactFixes, exactFixesOverlap } from "./exact-edits.js";
import {
  FIXABLE_CHECK_IDS,
  type CheckFixCandidate,
  type FixPlan,
  type FixPlanCheck,
  type FixPlanFile,
  type FixPlanItem,
  type FixPlanSummary,
  type FixableCheckId,
  type ExactFileFixCandidate,
  type ExactFixEdit,
  type FormatFileFixCandidate,
  type PreparedFixPlan,
  type WorkingFilePreview,
} from "./types.js";

export interface BuildFixPlanDependencies {
  loadConfig(
    repositoryRoot: string,
    configPath?: string,
  ): Promise<ResolvedConfig>;
  createGitClient(repositoryRoot: string): GitClient;
  readChangeSet(git: GitClient): Promise<ChangeSet>;
  buildSnapshots(repositoryRoot: string, git: GitClient): Promise<SnapshotPair>;
  inspectRepository(snapshotRoot: string): Promise<RepositoryInspection>;
  dispatch: typeof dispatchChecks;
  evaluate(
    results: readonly CheckExecutionResult[],
    config: ResolvedConfig,
  ): PolicyDecision;
  adapters: readonly CheckAdapter[];
  hasUnstagedChanges(
    git: GitClient,
    file: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}

export interface BuildFixPlanOptions {
  readonly repositoryRoot: string;
  readonly configPath?: string;
  readonly selectedChecks?: readonly FixableCheckId[];
  readonly signal?: AbortSignal;
  readonly dependencies?: BuildFixPlanDependencies;
}

export class FixPlanCleanupError extends Error {
  readonly temporaryPath?: string;

  constructor(temporaryPath?: string) {
    super("Zedbee could not remove its temporary snapshot.");
    this.name = "FixPlanCleanupError";
    if (temporaryPath !== undefined) this.temporaryPath = temporaryPath;
  }
}

const DEFAULT_DEPENDENCIES: BuildFixPlanDependencies = {
  loadConfig,
  createGitClient: (repositoryRoot) => new GitClient(repositoryRoot),
  readChangeSet: readStagedChangeSet,
  buildSnapshots: buildSnapshotPair,
  inspectRepository,
  dispatch: dispatchChecks,
  evaluate: evaluatePolicy,
  adapters: DEFAULT_CHECK_ADAPTERS,
  async hasUnstagedChanges(git, file, signal) {
    const result = await git.tryRun(["diff", "--quiet", "--", file], {
      signal,
    });
    if (result.exitCode === 0) return false;
    if (result.exitCode === 1) return true;
    throw new Error("Zedbee could not determine the working-file state.");
  },
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function readonlyMap<K, V>(
  entries: readonly (readonly [K, V])[],
): ReadonlyMap<K, V> {
  const internal = new Map(entries);
  let facade: ReadonlyMap<K, V>;
  facade = Object.freeze({
    get size() {
      return internal.size;
    },
    get(key: K) {
      return internal.get(key);
    },
    has(key: K) {
      return internal.has(key);
    },
    entries() {
      return internal.entries();
    },
    keys() {
      return internal.keys();
    },
    values() {
      return internal.values();
    },
    forEach(
      callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
      thisArg?: unknown,
    ) {
      internal.forEach((value, key) =>
        callback.call(thisArg, value, key, facade),
      );
    },
    [Symbol.iterator]() {
      return internal[Symbol.iterator]();
    },
  });
  return facade;
}

function selectedChecks(
  input: readonly FixableCheckId[] | undefined,
): readonly FixableCheckId[] {
  const selected = input === undefined ? FIXABLE_CHECK_IDS : input;
  if (!selected.every((checkId) => FIXABLE_CHECK_IDS.includes(checkId))) {
    throw new TypeError("Expected a supported managed fix check selector.");
  }
  return Object.freeze([...new Set(selected)]);
}

function selectedAdapters(
  adapters: readonly CheckAdapter[],
  selected: ReadonlySet<FixableCheckId>,
): readonly CheckAdapter[] {
  return Object.freeze(
    adapters.filter(
      (adapter) =>
        FIXABLE_CHECK_IDS.includes(adapter.id as FixableCheckId) &&
        selected.has(adapter.id as FixableCheckId),
    ),
  );
}

interface FixPlanItemDraft {
  readonly checkId: FixableCheckId;
  readonly file: string;
  readonly findingIds: readonly string[];
  readonly scope: "finding" | "working-file";
  readonly fixes: number;
  readonly status: "applicable" | "skipped";
  readonly reason?: string;
  readonly severities: readonly Readonly<{
    findingId: string;
    severity: "warning" | "error";
  }>[];
}

function itemForExact(
  candidate: ExactFileFixCandidate,
  edits: readonly ExactFixEdit[],
  reason?: string,
): FixPlanItemDraft {
  return Object.freeze({
    checkId: candidate.checkId,
    file: candidate.file,
    findingIds: Object.freeze([
      ...new Set(edits.map((edit) => edit.findingId)),
    ]),
    scope: "finding" as const,
    fixes: edits.length,
    status:
      reason === undefined ? ("applicable" as const) : ("skipped" as const),
    ...(reason === undefined ? {} : { reason }),
    severities: Object.freeze(
      edits.map((edit) => ({
        findingId: edit.findingId,
        severity: edit.severity,
      })),
    ),
  });
}

function itemForFormatting(
  candidate: FormatFileFixCandidate,
): FixPlanItemDraft {
  return Object.freeze({
    checkId: candidate.checkId,
    file: candidate.file,
    findingIds: Object.freeze([...new Set(candidate.findingIds)]),
    scope: "working-file" as const,
    fixes: 1,
    status: "applicable" as const,
    severities: Object.freeze(
      candidate.findingIds.map((findingId, index) => ({
        findingId,
        severity: candidate.severities[index]!,
      })),
    ),
  });
}

function finalizeItems(
  drafts: readonly FixPlanItemDraft[],
): readonly FixPlanItem[] {
  const countedFindings = new Set<string>();
  return Object.freeze(
    drafts
      .map((draft): FixPlanItem => {
        const severities = new Map<string, "warning" | "error">();
        for (const entry of draft.severities) {
          if (
            severities.get(entry.findingId) !== "error" ||
            entry.severity === "error"
          ) {
            severities.set(entry.findingId, entry.severity);
          }
        }
        const unique = [...severities].filter(([findingId]) => {
          if (countedFindings.has(findingId)) return false;
          countedFindings.add(findingId);
          return true;
        });
        return Object.freeze({
          checkId: draft.checkId,
          file: draft.file,
          findingIds: draft.findingIds,
          scope: draft.scope,
          fixes: draft.fixes,
          blocking: unique.filter(([, severity]) => severity === "error")
            .length,
          warnings: unique.filter(([, severity]) => severity === "warning")
            .length,
          status: draft.status,
          ...(draft.reason === undefined ? {} : { reason: draft.reason }),
        });
      })
      .sort(compareItems),
  );
}

function compareItems(left: FixPlanItem, right: FixPlanItem): number {
  return (
    compareCodeUnits(left.file, right.file) ||
    compareCodeUnits(left.checkId, right.checkId) ||
    compareCodeUnits(left.scope, right.scope) ||
    compareCodeUnits(left.findingIds[0] ?? "", right.findingIds[0] ?? "")
  );
}

interface PlannedCandidates {
  readonly candidates: readonly CheckFixCandidate[];
  readonly items: readonly FixPlanItem[];
}

const WORKING_OVERLAP_REASON = "Working changes overlap a managed exact fix.";
const MANAGED_OVERLAP_REASON = "Managed exact fixes overlap each other.";
const INCOMPATIBLE_BASE_REASON =
  "Managed exact fixes use incompatible staged sources.";

function planCandidates(
  candidates: readonly CheckFixCandidate[],
  workingFiles: ReadonlyMap<string, WorkingFilePreview>,
): PlannedCandidates {
  const reasons = new Map<ExactFixEdit, string>();
  const exactByFile = new Map<string, ExactFileFixCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.kind !== "exact-file") continue;
    const existing = exactByFile.get(candidate.file);
    if (existing === undefined) exactByFile.set(candidate.file, [candidate]);
    else existing.push(candidate);
  }

  for (const [file, exactCandidates] of exactByFile) {
    const baseSource = exactCandidates[0]!.baseSource;
    const entries = exactCandidates.flatMap((candidate) =>
      candidate.edits.map((edit) => ({ candidate, edit })),
    );
    if (
      exactCandidates.some((candidate) => candidate.baseSource !== baseSource)
    ) {
      for (const { edit } of entries)
        reasons.set(edit, INCOMPATIBLE_BASE_REASON);
      continue;
    }
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        if (exactFixesOverlap(entries[left]!.edit, entries[right]!.edit)) {
          reasons.set(entries[left]!.edit, MANAGED_OVERLAP_REASON);
          reasons.set(entries[right]!.edit, MANAGED_OVERLAP_REASON);
        }
      }
    }
    const preview = workingFiles.get(file);
    for (const { edit } of entries) {
      if (reasons.has(edit)) continue;
      if (
        preview === undefined ||
        composeExactFixes(baseSource, preview.content, [edit]) === undefined
      ) {
        reasons.set(edit, WORKING_OVERLAP_REASON);
      }
    }
  }

  const itemDrafts: FixPlanItemDraft[] = [];
  const applicable: CheckFixCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "format-file") {
      itemDrafts.push(itemForFormatting(candidate));
      applicable.push(candidate);
      continue;
    }
    const edits = candidate.edits.filter((edit) => !reasons.has(edit));
    const partitions = new Map<string | undefined, ExactFixEdit[]>();
    for (const edit of candidate.edits) {
      const reason = reasons.get(edit);
      const partition = partitions.get(reason);
      if (partition === undefined) partitions.set(reason, [edit]);
      else partition.push(edit);
    }
    for (const [reason, partition] of partitions) {
      itemDrafts.push(itemForExact(candidate, partition, reason));
    }
    if (edits.length > 0) {
      applicable.push(
        Object.freeze({ ...candidate, edits: Object.freeze(edits) }),
      );
    }
  }
  return Object.freeze({
    candidates: Object.freeze(applicable),
    items: finalizeItems(itemDrafts),
  });
}

function resolvePolicyForFile(
  executions: readonly CheckExecutionResult[],
): FilePolicyResolver | undefined {
  return executions.find((execution) => execution.policyForFile !== undefined)
    ?.policyForFile;
}

function addFormattingForExactCandidates(
  candidates: readonly CheckFixCandidate[],
  selected: ReadonlySet<FixableCheckId>,
  executions: readonly CheckExecutionResult[],
): readonly CheckFixCandidate[] {
  if (!selected.has("formatting")) return candidates;
  const policyForFile = resolvePolicyForFile(executions);
  if (policyForFile === undefined) return candidates;

  const byFile = new Map<string, FormatFileFixCandidate>();
  for (const candidate of candidates) {
    if (candidate.kind !== "format-file") continue;
    byFile.set(candidate.file, candidate);
  }
  for (const candidate of candidates) {
    if (
      candidate.kind !== "exact-file" ||
      prettierParserFor(candidate.file) === undefined
    ) {
      continue;
    }
    const policy = policyForFile("formatting", candidate.file, "target");
    if (policy.severity === "off") continue;
    const existing = byFile.get(candidate.file);
    const findingIds = [
      ...(existing?.findingIds ?? []),
      ...candidate.edits.map((edit) => edit.findingId),
    ];
    const severities = [
      ...(existing?.severities ?? []),
      ...candidate.edits.map((edit) => edit.severity),
    ];
    const [formatCandidate] = sanitizeFixCandidates(
      [
        {
          kind: "format-file",
          checkId: "formatting",
          file: candidate.file,
          findingIds,
          severities,
          settings: policy.settings,
        },
      ],
      { checkId: "formatting", findingIds },
    );
    byFile.set(candidate.file, formatCandidate as FormatFileFixCandidate);
  }
  const otherCandidates = candidates.filter(
    (candidate) => candidate.kind !== "format-file",
  );
  const formattingCandidates = [...byFile.values()];
  return Object.freeze([...otherCandidates, ...formattingCandidates]);
}

function collectCandidates(
  executions: readonly CheckExecutionResult[],
  selected: ReadonlySet<FixableCheckId>,
): readonly CheckFixCandidate[] {
  const incompleteChecks = new Set(
    executions
      .filter((execution) => execution.result.status === "incomplete")
      .map((execution) => execution.result.checkId),
  );
  const candidates = executions.flatMap((execution) =>
    execution.result.status === "completed"
      ? (execution.fixCandidates ?? [])
      : [],
  );
  const filtered = candidates.filter(
    (candidate) =>
      selected.has(candidate.checkId) &&
      !incompleteChecks.has(candidate.checkId),
  );
  return Object.freeze(
    addFormattingForExactCandidates(filtered, selected, executions).filter(
      (candidate) => !incompleteChecks.has(candidate.checkId),
    ),
  );
}

async function workingFilePreviews(
  repositoryRoot: string,
  candidates: readonly CheckFixCandidate[],
  git: GitClient,
  signal: AbortSignal,
  dependencies: BuildFixPlanDependencies,
): Promise<ReadonlyMap<string, WorkingFilePreview>> {
  const files = [
    ...new Set(candidates.map((candidate) => candidate.file)),
  ].sort(compareCodeUnits);
  if (files.length === 0) return readonlyMap([]);
  const registry = await captureSnapshotRegistry(
    await canonicalizeSnapshotRoot(repositoryRoot),
  );
  const previews = await Promise.all(
    files.map(async (file) => {
      signal.throwIfAborted();
      const entry = registry.exact(file);
      if (entry?.kind !== "file" || entry.targetKind !== "file") {
        throw new TypeError("Zedbee refused an unsafe working-file path.");
      }
      const content = await readContainedFile(registry, file);
      const metadata = await lstat(entry.canonicalPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new TypeError("Zedbee refused an unsafe working-file path.");
      }
      const preview: WorkingFilePreview = Object.freeze({
        path: file,
        sha256: createHash("sha256").update(content, "utf8").digest("hex"),
        content,
        mode: metadata.mode & 0o777,
        hasUnstagedChanges: await dependencies.hasUnstagedChanges(
          git,
          file,
          signal,
        ),
      });
      return [file, preview] as const;
    }),
  );
  return readonlyMap(previews);
}

function publicPlan(
  selected: readonly FixableCheckId[],
  items: readonly FixPlanItem[],
  workingFiles: ReadonlyMap<string, WorkingFilePreview>,
  checks: readonly FixPlanCheck[],
  decision?: PolicyDecision,
): FixPlan {
  const fixesFor = (item: FixPlanItem): number =>
    item.fixes ?? (item.scope === "finding" ? item.findingIds.length : 1);
  const applicableFindingIds = new Set(
    items
      .filter((item) => item.status !== "skipped")
      .flatMap((item) => item.findingIds),
  );
  const hasUnresolvedBlockingFinding =
    decision?.summary.findings.some(
      (finding) =>
        finding.severity === "error" &&
        !applicableFindingIds.has(finding.id),
    ) ?? false;
  const files = [...workingFiles.values()]
    .map((preview): FixPlanFile => {
      const fileItems = items.filter((item) => item.file === preview.path);
      const fixes = fileItems.reduce(
        (total, item) => total + fixesFor(item),
        0,
      );
      const skippedFixes = fileItems
        .filter((item) => item.status === "skipped")
        .reduce((total, item) => total + fixesFor(item), 0);
      const applicableFixes = fixes - skippedFixes;
      const reasons = [
        ...new Set(
          fileItems.flatMap((item) =>
            item.status === "skipped" && item.reason !== undefined
              ? [item.reason]
              : [],
          ),
        ),
      ];
      return Object.freeze({
        path: preview.path,
        fixes,
        applicableFixes,
        skippedFixes,
        status:
          skippedFixes === 0
            ? ("applicable" as const)
            : applicableFixes === 0
              ? ("skipped" as const)
              : ("partial" as const),
        reasons: Object.freeze(reasons),
        hasUnstagedChanges: preview.hasUnstagedChanges,
      });
    })
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const summary: FixPlanSummary = Object.freeze({
    fixes: items.reduce((total, item) => total + fixesFor(item), 0),
    files: files.length,
    blocking: items.reduce((total, item) => total + item.blocking, 0),
    warnings: items.reduce((total, item) => total + item.warnings, 0),
    skipped: items
      .filter((item) => item.status === "skipped")
      .reduce((total, item) => total + fixesFor(item), 0),
  });
  return deepFreeze({
    schemaVersion: 1 as const,
    target: "index" as const,
    selectedChecks: selected,
    exitCode:
      checks.some((check) => check.status === "incomplete") ||
      hasUnresolvedBlockingFinding
        ? (1 as const)
        : (0 as const),
    checks,
    summary,
    files,
    items,
  });
}

function planChecks(
  selected: readonly FixableCheckId[],
  executions: readonly CheckExecutionResult[],
  items: readonly FixPlanItem[],
): readonly FixPlanCheck[] {
  const fixesFor = (item: FixPlanItem): number =>
    item.fixes ?? (item.scope === "finding" ? item.findingIds.length : 1);
  return Object.freeze(
    selected.map((checkId): FixPlanCheck => {
      const checkExecutions = executions.filter(
        (execution) => execution.result.checkId === checkId,
      );
      const incomplete = checkExecutions.filter(
        (execution) => execution.result.status === "incomplete",
      );
      const completed = checkExecutions.some(
        (execution) => execution.result.status === "completed",
      );
      const fixes = items
        .filter((item) => item.checkId === checkId && item.status !== "skipped")
        .reduce((total, item) => total + fixesFor(item), 0);
      const issues = incomplete.flatMap((execution) => {
        const error = execution.result.error;
        return error === undefined
          ? [
              {
                code: "CHECK_INCOMPLETE",
                message: "The check could not finish.",
              },
            ]
          : [
              {
                code: error.code,
                message: error.message,
                ...(error.path === undefined ? {} : { path: error.path }),
                ...(error.remediation === undefined
                  ? {}
                  : { remediation: error.remediation }),
              },
            ];
      });
      if (incomplete.length > 0) {
        return Object.freeze({
          checkId,
          status: "incomplete" as const,
          fixes,
          issues: Object.freeze(issues),
        });
      }
      if (completed || fixes > 0) {
        return Object.freeze({
          checkId,
          status: "completed" as const,
          fixes,
          issues: Object.freeze([]),
        });
      }
      const reasons = checkExecutions.flatMap((execution) =>
        execution.result.skipReason === undefined
          ? []
          : [execution.result.skipReason],
      );
      return Object.freeze({
        checkId,
        status: "not-applicable" as const,
        fixes: 0,
        issues: Object.freeze([]),
        reason: reasons[0] ?? "No applicable target was found.",
      });
    }),
  );
}

function unsupportedInputError(): Error {
  return new Error(
    "Zedbee cannot build a fix plan for unsupported staged input.",
  );
}

function cleanupError(snapshots: SnapshotPair): FixPlanCleanupError {
  let temporaryPath: string | undefined;
  try {
    temporaryPath = validateReportableSnapshotPath(
      dirname(snapshots.targetDir),
    );
  } catch {
    temporaryPath = undefined;
  }
  return new FixPlanCleanupError(temporaryPath);
}

export async function buildFixPlan(
  options: BuildFixPlanOptions,
): Promise<PreparedFixPlan> {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const selected = selectedChecks(options.selectedChecks);
  const selectedSet = new Set(selected);
  const controller =
    options.signal === undefined ? new AbortController() : undefined;
  const signal = options.signal ?? controller!.signal;
  let snapshots: SnapshotPair | undefined;
  try {
    signal.throwIfAborted();
    const config = await dependencies.loadConfig(
      options.repositoryRoot,
      options.configPath,
    );
    const git = dependencies.createGitClient(options.repositoryRoot);
    const changeSet = await dependencies.readChangeSet(git);
    if (changeSet.isEmpty) {
      return deepFreeze({
        publicPlan: publicPlan(
          selected,
          [],
          readonlyMap([]),
          planChecks(selected, [], []),
        ),
        repositoryRoot: options.repositoryRoot,
        candidates: Object.freeze([]),
        workingFiles: readonlyMap([]),
        temporaryReportMaxAgeMs: parseTemporaryReportMaxAge(
          config.reporting.temporaryReportMaxAge,
        ),
      });
    }
    signal.throwIfAborted();
    snapshots = await dependencies.buildSnapshots(options.repositoryRoot, git);
    const unsupported = unsupportedEntryFailures(
      snapshots.unsupportedEntries,
      config,
      new Set(changeSet.files.keys()),
    );
    if (unsupported.length > 0) throw unsupportedInputError();
    signal.throwIfAborted();
    const baselineInspection = await dependencies.inspectRepository(
      snapshots.baselineDir,
    );
    signal.throwIfAborted();
    const targetInspection = await dependencies.inspectRepository(
      snapshots.targetDir,
    );
    signal.throwIfAborted();
    const executions = await dependencies.dispatch(
      selectedAdapters(dependencies.adapters, selectedSet),
      {
        repositoryRoot: options.repositoryRoot,
        changeSet,
        config,
        snapshots,
        baselineInspection,
        targetInspection,
        signal,
      },
      { collectFixes: true },
    );
    const decision = dependencies.evaluate(executions, config);
    signal.throwIfAborted();
    const candidates = collectCandidates(executions, selectedSet);
    const workingFiles = await workingFilePreviews(
      options.repositoryRoot,
      candidates,
      git,
      signal,
      dependencies,
    );
    const planned = planCandidates(candidates, workingFiles);
    const checks = planChecks(selected, executions, planned.items);
    return deepFreeze({
      publicPlan: publicPlan(
        selected,
        planned.items,
        workingFiles,
        checks,
        decision,
      ),
      repositoryRoot: options.repositoryRoot,
      candidates: planned.candidates,
      workingFiles,
      temporaryReportMaxAgeMs: parseTemporaryReportMaxAge(
        config.reporting.temporaryReportMaxAge,
      ),
    });
  } finally {
    if (snapshots !== undefined) {
      try {
        await snapshots.cleanup();
      } catch {
        throw cleanupError(snapshots);
      }
    }
  }
}

/** Serializes only the public, source-free plan projection. */
export function renderFixPlanJson(plan: FixPlan): string {
  return `${JSON.stringify(
    {
      schemaVersion: plan.schemaVersion,
      target: plan.target,
      selectedChecks: [...plan.selectedChecks],
      exitCode: plan.exitCode,
      ...(plan.checks === undefined
        ? {}
        : {
            checks: plan.checks.map((check) => ({
              checkId: check.checkId,
              status: check.status,
              fixes: check.fixes,
              issues: check.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                ...(issue.path === undefined ? {} : { path: issue.path }),
                ...(issue.remediation === undefined
                  ? {}
                  : { remediation: issue.remediation }),
              })),
              ...(check.reason === undefined ? {} : { reason: check.reason }),
            })),
          }),
      summary: {
        fixes: plan.summary.fixes,
        files: plan.summary.files,
        blocking: plan.summary.blocking,
        warnings: plan.summary.warnings,
        skipped: plan.summary.skipped,
      },
      files: plan.files.map((file) => ({
        path: file.path,
        fixes: file.fixes,
        ...(file.applicableFixes === undefined
          ? {}
          : { applicableFixes: file.applicableFixes }),
        ...(file.skippedFixes === undefined
          ? {}
          : { skippedFixes: file.skippedFixes }),
        ...(file.status === undefined ? {} : { status: file.status }),
        ...(file.reasons === undefined ? {} : { reasons: [...file.reasons] }),
        hasUnstagedChanges: file.hasUnstagedChanges,
      })),
      items: plan.items.map((item) => ({
        checkId: item.checkId,
        file: item.file,
        findingIds: [...item.findingIds],
        scope: item.scope,
        ...(item.fixes === undefined ? {} : { fixes: item.fixes }),
        blocking: item.blocking,
        warnings: item.warnings,
        ...(item.status === undefined ? {} : { status: item.status }),
        ...(item.reason === undefined ? {} : { reason: item.reason }),
      })),
    },
    null,
    2,
  )}\n`;
}
