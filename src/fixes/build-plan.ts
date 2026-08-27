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
import {
  FIXABLE_CHECK_IDS,
  type CheckFixCandidate,
  type FixPlan,
  type FixPlanFile,
  type FixPlanItem,
  type FixPlanSummary,
  type FixableCheckId,
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

function candidateFindingIds(candidate: CheckFixCandidate): readonly string[] {
  return candidate.kind === "exact-file"
    ? candidate.edits.map((edit) => edit.findingId)
    : candidate.findingIds;
}

function candidateSeverities(
  candidate: CheckFixCandidate,
): readonly ("warning" | "error")[] {
  return candidate.kind === "exact-file"
    ? candidate.edits.map((edit) => edit.severity)
    : candidate.severities;
}

function itemFor(candidate: CheckFixCandidate): FixPlanItem {
  const severities = candidateSeverities(candidate);
  return Object.freeze({
    checkId: candidate.checkId,
    file: candidate.file,
    findingIds: Object.freeze([...candidateFindingIds(candidate)]),
    scope: candidate.kind === "exact-file" ? "finding" : "working-file",
    blocking: severities.filter((severity) => severity === "error").length,
    warnings: severities.filter((severity) => severity === "warning").length,
  });
}

function compareItems(left: FixPlanItem, right: FixPlanItem): number {
  return (
    compareCodeUnits(left.file, right.file) ||
    compareCodeUnits(left.checkId, right.checkId) ||
    compareCodeUnits(left.scope, right.scope)
  );
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
  const candidates = executions.flatMap((execution) =>
    execution.result.status === "completed"
      ? (execution.fixCandidates ?? [])
      : [],
  );
  const filtered = candidates.filter((candidate) =>
    selected.has(candidate.checkId),
  );
  return addFormattingForExactCandidates(filtered, selected, executions);
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
  candidates: readonly CheckFixCandidate[],
  workingFiles: ReadonlyMap<string, WorkingFilePreview>,
  incomplete: boolean,
): FixPlan {
  const items = candidates.map(itemFor).sort(compareItems);
  const files = [...workingFiles.values()]
    .map((preview): FixPlanFile =>
      Object.freeze({
        path: preview.path,
        fixes: items.filter((item) => item.file === preview.path).length,
        hasUnstagedChanges: preview.hasUnstagedChanges,
      }),
    )
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const summary: FixPlanSummary = Object.freeze({
    fixes: items.length,
    files: files.length,
    blocking: items.reduce((total, item) => total + item.blocking, 0),
    warnings: items.reduce((total, item) => total + item.warnings, 0),
    skipped: 0,
  });
  return deepFreeze({
    schemaVersion: 1 as const,
    target: "index" as const,
    selectedChecks: selected,
    exitCode: incomplete ? (2 as const) : (0 as const),
    summary,
    files,
    items,
  });
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
        publicPlan: publicPlan(selected, [], readonlyMap([]), false),
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
    dependencies.evaluate(executions, config);
    signal.throwIfAborted();
    const candidates = collectCandidates(executions, selectedSet);
    const workingFiles = await workingFilePreviews(
      options.repositoryRoot,
      candidates,
      git,
      signal,
      dependencies,
    );
    const incomplete = executions.some(
      (execution) => execution.result.status === "incomplete",
    );
    return deepFreeze({
      publicPlan: publicPlan(selected, candidates, workingFiles, incomplete),
      repositoryRoot: options.repositoryRoot,
      candidates: Object.freeze([...candidates]),
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
        hasUnstagedChanges: file.hasUnstagedChanges,
      })),
      items: plan.items.map((item) => ({
        checkId: item.checkId,
        file: item.file,
        findingIds: [...item.findingIds],
        scope: item.scope,
        blocking: item.blocking,
        warnings: item.warnings,
      })),
    },
    null,
    2,
  )}\n`;
}
