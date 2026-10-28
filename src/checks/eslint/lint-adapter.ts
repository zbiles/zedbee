import { inspectManagedCheck } from "../applicability.js";
import { collectRenamedBaselines } from "../renamed-baselines.js";
import { compilerInputsMayHaveChanged } from "../compiler-inputs.js";
import { relative, sep } from "node:path";
import type * as ts from "typescript";
import type { ESLint } from "eslint";
import type {
  CheckObservationSet,
  CheckRunContext,
  CheckTarget,
  ObservationCheckAdapter,
} from "../adapter.js";
import type { Observation } from "../../core/types.js";
import { compareCodeUnits } from "../../core/compare.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import {
  pairLocationObservations,
  type SnapshotLocationObservations,
} from "../../attribution/pair-locations.js";
import { convertEslintMessage } from "./convert-message.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import { analyzerDiagnostic, type AnalyzerOperation } from "../diagnostics.js";
import { createManagedEslint } from "./load-engine.js";
import { eslintFailureDetails, ManagedEslintFailure } from "./failure.js";
import { planManagedEslintFixes } from "../../fixes/eslint-provider.js";
import { captureAnalysisDependencies } from "../typescript/reuse-inputs.js";
import {
  createSnapshotProjectCoverage,
  type SnapshotProjectCoverage,
} from "../typescript/project-coverage.js";
import { settleSnapshotSides } from "../settle-snapshot-sides.js";
import { isAnalyzerWorker } from "../runner/context.js";
import type {
  FilePolicyResolver,
  SnapshotSide,
} from "../../config/file-policy.js";
import { groupFilesByRules } from "./managed-config.js";
import type { ManagedEslintOptions } from "./load-engine.js";

const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/u;
const JAVASCRIPT_SOURCE = /\.(?:js|jsx|mjs|cjs)$/u;

type LintEslintEngineFactory = (
  options: ManagedEslintOptions,
) => Pick<ESLint, "lintFiles">;

interface PreparedLintSide {
  readonly canonicalRoot: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly groups: ReturnType<typeof groupFilesByRules>;
  readonly typedProject?: { readonly programs: readonly ts.Program[] };
  readonly coveredTypeScript?: ReadonlySet<string>;
  readonly projectPaths?: readonly string[];
}

function lintBatches(
  prepared: PreparedLintSide,
  files: readonly string[],
): readonly Readonly<{ files: readonly string[]; basic: boolean }>[] {
  const covered = prepared.coveredTypeScript ?? new Set<string>();
  const typedFiles = files.filter(
    (path) => !TYPESCRIPT_SOURCE.test(path) || covered.has(path),
  );
  const basicFiles = files.filter(
    (path) => TYPESCRIPT_SOURCE.test(path) && !covered.has(path),
  );
  return Object.freeze([
    ...(typedFiles.length === 0
      ? []
      : [{ files: Object.freeze(typedFiles), basic: false }]),
    ...(basicFiles.length === 0
      ? []
      : [{ files: Object.freeze(basicFiles), basic: true }]),
  ]);
}

function workspaceFor(
  inspection: RepositoryInspection,
  target: CheckTarget,
): WorkspaceInspection | undefined {
  return inspection.workspaces.find(
    (workspace) => workspace.relativeRoot === target.relativeRoot,
  );
}

function snapshotLabel(side: SnapshotSide, ref?: string | null): string {
  const label = side === "baseline" ? "baseline snapshot" : "target snapshot";
  // Only trusted, resolved Git identities are useful here. Never echo arbitrary
  // CLI references or exception prose into a diagnostic.
  return typeof ref === "string" && /^(?:HEAD|[a-f0-9]{40,64})$/iu.test(ref)
    ? `${label} (${ref})`
    : label;
}

function typedFailure(options: {
  readonly side: SnapshotSide;
  readonly ref: string | null | undefined;
  readonly files: readonly string[];
  readonly projectPaths: readonly string[] | undefined;
  readonly reason: "parser" | "execution" | "invalid-response";
  readonly operation?: AnalyzerOperation;
  readonly error?: unknown;
}): CheckIncompleteError {
  const failure =
    options.reason !== "execution"
      ? undefined
      : options.error instanceof ManagedEslintFailure
        ? options.error.details
        : eslintFailureDetails(options.error);
  const failedPath =
    options.error instanceof ManagedEslintFailure &&
    options.files.includes(options.error.path)
      ? options.error.path
      : undefined;
  const files = failedPath === undefined ? options.files : [failedPath];
  const explanation =
    options.reason === "parser"
      ? "The TypeScript parser rejected a requested file without a source location."
      : options.reason === "invalid-response"
        ? "ESLint returned a file outside the requested batch."
        : failedPath === undefined
          ? "ESLint failed while analyzing the requested batch; the failing file is unknown."
          : "ESLint failed while analyzing the identified file; the remaining batch was not completed.";
  const details =
    failure === undefined
      ? ""
      : [
          failure.type === undefined ? "" : ` Error type: ${failure.type}.`,
          failure.ruleId === undefined
            ? ""
            : ` Managed rule: ${failure.ruleId}.`,
          failure.reason === undefined
            ? ""
            : " Known engine error: Cannot read properties of undefined (reading 'some'). The promise rule received an unexpected TypeScript type shape.",
        ].join("");
  return new CheckIncompleteError({
    code: "TYPED_LINT_ANALYSIS_FAILED",
    message: `Typed lint could not complete for the ${snapshotLabel(options.side, options.ref)}. ${explanation}${details}`,
    remediation: `${failure?.reason === undefined ? "" : "Reinstall an updated Zedbee package so its TypeScript analyzer dependencies are installed together, then retry. "}Project coverage was prepared before this failure. Use the requested paths, loaded projects, snapshot identity, and analyzer diagnostic to report a Zedbee typed-lint compatibility issue. For a commit comparison, inspect the configurations tracked in the baseline and target commits.`,
    paths: files,
    ...(files.length === 1 ? { path: files[0]! } : {}),
    ...(options.projectPaths === undefined
      ? {}
      : { projectPaths: options.projectPaths }),
    diagnostic: {
      ...analyzerDiagnostic(
        "lint",
        options.operation ?? "collect",
        options.reason === "invalid-response"
          ? "invalid-response"
          : "execution",
      ),
      snapshot: options.side,
      ...(failure === undefined ? {} : { failure }),
    },
  });
}

async function prepareSide(
  snapshotRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
  side: SnapshotSide,
  policyForFile: FilePolicyResolver,
  signal: AbortSignal,
  coverage: SnapshotProjectCoverage,
  snapshotRef?: string | null,
  operation: AnalyzerOperation = "collect",
  requestedPaths?: ReadonlySet<string>,
): Promise<PreparedLintSide | undefined> {
  signal.throwIfAborted();
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (canonicalRoot !== inspection.snapshotRoot) {
    throw new Error("Managed lint analysis failed.");
  }
  const workspace = workspaceFor(inspection, target);
  if (workspace === undefined) return undefined;
  const files = workspace.sourceFiles
    .filter((path) => requestedPaths === undefined || requestedPaths.has(path))
    .filter(
      (path) => JAVASCRIPT_SOURCE.test(path) || TYPESCRIPT_SOURCE.test(path),
    )
    .sort(compareCodeUnits);
  if (files.length === 0) return undefined;
  const groups = groupFilesByRules(files, side, policyForFile, "lint");
  if (groups.length === 0) return undefined;
  const typescriptFiles = groups
    .flatMap(({ files: groupFiles }) => groupFiles)
    .filter((path) => TYPESCRIPT_SOURCE.test(path));
  if (typescriptFiles.length === 0) return { canonicalRoot, groups };

  if (workspace.tsconfigPaths.length === 0) {
    const blocking = typescriptFiles.filter(
      (path) =>
        policyForFile("lint", path, side).typeInformation === "required",
    );
    if (blocking.length === 0) {
      return {
        canonicalRoot,
        groups,
        coveredTypeScript: new Set<string>(),
      };
    }
  }

  try {
    const {
      programs,
      covered,
      projectPaths,
      files: projectFiles,
    } = await coverage.load(workspace, side);
    signal.throwIfAborted();
    const uncovered = typescriptFiles
      .filter((path) => !covered.has(path))
      .sort(compareCodeUnits);
    const blocking = await coverage.required(
      uncovered.filter(
        (path) =>
          policyForFile("lint", path, side).typeInformation === "required",
      ),
      workspace,
      side,
    );
    if (blocking.length > 0) {
      throw new CheckIncompleteError({
        code: "TYPED_LINT_PROJECT_MISMATCH",
        message:
          "Zedbee found TypeScript files that are not included in any loaded TypeScript project. Typed lint stopped because unrelated project settings could produce inaccurate results.",
        remediation:
          'Add these files to "files" or "include" in the correct tsconfig.json. If they belong to another project, ensure Zedbee can find that project\'s tsconfig.json. If they are intentionally outside a project, set checks.lint.typeInformation to "when-available" for those files to run basic lint instead.',
        path: blocking[0]!,
        paths: blocking,
        snapshot: side === "baseline" ? "last-commit" : "staged",
        projectPaths,
      });
    }
    return {
      canonicalRoot,
      groups: groups
        .map((group) => ({
          ...group,
          files: group.files.filter(
            (path) =>
              !uncovered.includes(path) ||
              policyForFile("lint", path, side).typeInformation ===
                "when-available",
          ),
        }))
        .filter((group) => group.files.length > 0),
      typedProject: { programs },
      coveredTypeScript: covered,
      projectPaths,
      files: projectFiles,
    };
  } catch (error) {
    if (error instanceof CheckIncompleteError) throw error;
    throw new CheckIncompleteError({
      code: "TYPED_LINT_SETUP_FAILED",
      message: `Typed lint could not build a usable project from this workspace's TypeScript configuration for the ${snapshotLabel(side, snapshotRef)}.`,
      remediation:
        "Verify that the failing snapshot contains a tsconfig.json covering its requested TypeScript files and all referenced configurations, then retry. For a commit comparison, check the configurations tracked in that commit.",
      paths: typescriptFiles,
      projectPaths: workspace.tsconfigPaths,
      diagnostic: {
        ...analyzerDiagnostic("lint", operation, "startup"),
        snapshot: side,
      },
    });
  }
}

async function collectSide(
  snapshotRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
  side: SnapshotSide,
  policyForFile: FilePolicyResolver,
  engineFactory: LintEslintEngineFactory,
  signal: AbortSignal,
  coverage: SnapshotProjectCoverage,
  snapshotRef?: string | null,
  requestedPaths?: ReadonlySet<string>,
): Promise<SnapshotLocationObservations> {
  const prepared = await prepareSide(
    snapshotRoot,
    inspection,
    target,
    side,
    policyForFile,
    signal,
    coverage,
    snapshotRef,
    "collect",
    requestedPaths,
  );
  if (prepared === undefined)
    return { observations: Object.freeze([]), files: {} };
  const observations: Observation[] = [];
  for (const group of prepared.groups) {
    signal.throwIfAborted();
    for (const batch of lintBatches(prepared, group.files)) {
      const groupHasTypescript = batch.files.some((path) =>
        TYPESCRIPT_SOURCE.test(path),
      );
      try {
        const engine = engineFactory({
          cwd: prepared.canonicalRoot,
          mode: "lint",
          managedIgnores: [],
          ruleOverrides: group.rules,
          ...(batch.basic
            ? { typeInformation: "basic" as const }
            : prepared.typedProject === undefined
              ? {}
              : { typedProject: prepared.typedProject }),
        });
        const results = await engine.lintFiles([...batch.files]);
        signal.throwIfAborted();
        const allowed = new Set(batch.files);
        for (const result of results) {
          const path = relative(prepared.canonicalRoot, result.filePath)
            .split(sep)
            .join("/");
          if (!allowed.has(path)) {
            if (groupHasTypescript)
              throw typedFailure({
                side,
                ref: snapshotRef,
                files: batch.files,
                projectPaths: prepared.projectPaths,
                reason: "invalid-response",
              });
            throw new TypeError("ESLint returned an unrequested file");
          }
          if (
            TYPESCRIPT_SOURCE.test(path) &&
            result.messages.some(
              (message) =>
                message.fatal === true &&
                (!Number.isSafeInteger(message.line) || message.line < 1),
            )
          ) {
            throw typedFailure({
              side,
              ref: snapshotRef,
              files: [path],
              projectPaths: prepared.projectPaths,
              reason: "parser",
            });
          }
          observations.push(
            ...result.messages.map((message) =>
              convertEslintMessage(path, message, prepared.canonicalRoot),
            ),
          );
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CheckIncompleteError) throw error;
        if (groupHasTypescript) {
          throw typedFailure({
            side,
            ref: snapshotRef,
            files: batch.files,
            projectPaths: prepared.projectPaths,
            reason: "execution",
            error,
          });
        }
        throw new Error("Managed lint analysis failed.");
      }
    }
  }
  const files: Record<string, string> = {};
  let registry: Awaited<ReturnType<typeof captureSnapshotRegistry>> | undefined;
  for (const observation of observations) {
    const path = observation.location?.file;
    if (path === undefined || files[path] !== undefined) continue;
    signal.throwIfAborted();
    files[path] =
      prepared.files?.[path] ??
      (await readContainedFile(
        (registry ??= await captureSnapshotRegistry(prepared.canonicalRoot)),
        path,
      ));
  }
  return {
    observations: Object.freeze(
      observations.sort(
        (left, right) =>
          compareCodeUnits(left.identity, right.identity) ||
          compareCodeUnits(left.message, right.message),
      ),
    ),
    files,
  };
}

export function createLintAdapter(
  engineFactory: LintEslintEngineFactory = createManagedEslint,
): ObservationCheckAdapter {
  return {
    id: "lint",
    output: "observations",

    inspect: (context: import("../adapter.js").InspectionContext) =>
      inspectManagedCheck("lint", context),

    async planFixes(context, findings) {
      const prepared = await prepareSide(
        context.snapshots.targetDir,
        context.targetInspection,
        context.target,
        "target",
        context.policyForFile,
        context.signal,
        createSnapshotProjectCoverage(context, "lint", undefined, "planFixes"),
        context.snapshots.targetRef,
        "planFixes",
      );
      if (prepared === undefined) return Object.freeze([]);
      const candidates = [];
      for (const group of prepared.groups) {
        context.signal.throwIfAborted();
        for (const batch of lintBatches(prepared, group.files)) {
          const groupHasTypescript = batch.files.some((path) =>
            TYPESCRIPT_SOURCE.test(path),
          );
          try {
            candidates.push(
              ...(await planManagedEslintFixes(
                {
                  context,
                  checkId: "lint",
                  files: batch.files,
                  createEngine: () =>
                    engineFactory({
                      cwd: prepared.canonicalRoot,
                      mode: "lint",
                      managedIgnores: [],
                      ruleOverrides: group.rules,
                      ...(batch.basic
                        ? { typeInformation: "basic" as const }
                        : prepared.typedProject === undefined
                          ? {}
                          : { typedProject: prepared.typedProject }),
                    }),
                },
                findings,
              )),
            );
          } catch (error) {
            context.signal.throwIfAborted();
            if (error instanceof CheckIncompleteError) throw error;
            if (groupHasTypescript) {
              throw typedFailure({
                side: "target",
                ref: context.snapshots.targetRef,
                files: batch.files,
                projectPaths: prepared.projectPaths,
                reason: "execution",
                error,
                operation: "planFixes",
              });
            }
            throw new Error("Managed lint fix planning failed.");
          }
        }
      }
      return Object.freeze(candidates);
    },

    async collect(context): Promise<CheckObservationSet> {
      const dependencies = captureAnalysisDependencies(context);
      const coverage = createSnapshotProjectCoverage(
        context,
        "lint",
        dependencies,
      );
      const [baseline, target] = await settleSnapshotSides(
        () =>
          collectRenamedBaselines(context, (baselineTarget, paths) =>
            collectSide(
              context.snapshots.baselineDir,
              context.baselineInspection,
              baselineTarget,
              "baseline",
              context.policyForFile,
              engineFactory,
              context.signal,
              coverage,
              context.snapshots.baselineRef,
              paths,
            ),
          ),
        () =>
          collectSide(
            context.snapshots.targetDir,
            context.targetInspection,
            context.target,
            "target",
            context.policyForFile,
            engineFactory,
            context.signal,
            coverage,
            context.snapshots.targetRef,
          ),
        context.signal,
        isAnalyzerWorker(),
      );
      const dependencyInputs = dependencies.manifest();
      const workspace = workspaceFor(context.targetInspection, context.target);
      return {
        checkId: "lint",
        target: context.target,
        ...pairLocationObservations(baseline, target, context.changeSet),
        projectDelta:
          workspace !== undefined &&
          compilerInputsMayHaveChanged(workspace, context.changeSet),
        ...(dependencyInputs === undefined ? {} : { dependencyInputs }),
      };
    },
  };
}

export const lintAdapter: ObservationCheckAdapter = createLintAdapter();
