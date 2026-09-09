import { inspectManagedCheck } from "../applicability.js";
import { relative, sep } from "node:path";
import type { ESLint } from "eslint";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import { canonicalizeSnapshotRoot } from "../../inspection/read-json.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import type {
  CheckObservationSet,
  CheckRunContext,
  CheckTarget,
  ObservationCheckAdapter,
} from "../adapter.js";
import { convertEslintMessage } from "../eslint/convert-message.js";
import {
  createManagedEslint,
  type ManagedEslintOptions,
} from "../eslint/load-engine.js";
import type {
  ManagedEslintMode,
  ReactCorrectnessConfigFactory,
} from "../eslint/managed-config.js";
import { managedReactCorrectnessConfig } from "./config.js";
import type {
  FilePolicyResolver,
  SnapshotSide,
} from "../../config/file-policy.js";
import { groupFilesByRules } from "../eslint/managed-config.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import { settleSnapshotSides } from "../settle-snapshot-sides.js";
import { isAnalyzerWorker } from "../runner/context.js";
import { planManagedEslintFixes } from "../../fixes/eslint-provider.js";
import {
  createReactVersionResolver,
  type ReactVersionResolver,
} from "./version.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;

type ReactEslintEngineFactory = (
  options: ManagedEslintOptions,
) => Pick<ESLint, "lintFiles">;

interface PreparedSide {
  readonly canonicalRoot: string;
  readonly groups: ReturnType<typeof groupFilesByRules>;
  readonly reactVersion?: string;
}

type ReactVersionResolverFactory = (
  inspection: RepositoryInspection,
) => Promise<ReactVersionResolver>;

type ResolveWorkspaceReactVersion = (
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
) => Promise<string>;

function reactAnalysisFailure(
  id: "reactCorrectness" | "reactAccessibility",
  path?: string,
): CheckIncompleteError {
  const correctness = id === "reactCorrectness";
  return new CheckIncompleteError({
    code: correctness
      ? "REACT_CORRECTNESS_ANALYSIS_FAILED"
      : "REACT_ACCESSIBILITY_ANALYSIS_FAILED",
    message: correctness
      ? "React correctness analysis could not analyze every requested source file."
      : "React accessibility analysis could not analyze every requested source file.",
    remediation:
      "Verify that the source file uses supported JavaScript or TypeScript syntax, then retry. If it does, report a Zedbee React analyzer compatibility issue.",
    ...(path === undefined ? {} : { path }),
  });
}

function workspaceFor(
  inspection: RepositoryInspection,
  target: CheckTarget,
): WorkspaceInspection | undefined {
  return inspection.workspaces.find(
    ({ relativeRoot }) => relativeRoot === target.relativeRoot,
  );
}

async function prepareSide(
  snapshotRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
  id: "reactCorrectness" | "reactAccessibility",
  mode: ManagedEslintMode,
  resolveWorkspaceReactVersion: ResolveWorkspaceReactVersion,
  side: SnapshotSide,
  policyForFile: FilePolicyResolver,
  signal: AbortSignal,
): Promise<PreparedSide | undefined> {
  const failure =
    id === "reactCorrectness"
      ? "React correctness analysis failed."
      : "React accessibility analysis failed.";
  signal.throwIfAborted();
  try {
    const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
    if (canonicalRoot !== inspection.snapshotRoot) throw new Error(failure);
    const workspace = workspaceFor(inspection, target);
    if (workspace === undefined) return undefined;
    const files = workspace.sourceFiles
      .filter((path) => SOURCE.test(path))
      .sort(compareCodeUnits);
    if (files.length === 0) return undefined;
    const groups = groupFilesByRules(files, side, policyForFile, id);
    if (groups.length === 0) return undefined;

    const reactVersion =
      mode === "react-correctness"
        ? await resolveWorkspaceReactVersion(inspection, workspace)
        : undefined;
    signal.throwIfAborted();
    return {
      canonicalRoot,
      groups,
      ...(reactVersion === undefined ? {} : { reactVersion }),
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CheckIncompleteError) throw error;
    throw new Error(failure);
  }
}

async function collectPreparedSide(
  prepared: PreparedSide | undefined,
  id: "reactCorrectness" | "reactAccessibility",
  mode: ManagedEslintMode,
  reactCorrectnessConfigFactory: ReactCorrectnessConfigFactory,
  engineFactory: ReactEslintEngineFactory,
  signal: AbortSignal,
): Promise<readonly Observation[]> {
  if (prepared === undefined) return Object.freeze([]);
  const observations: Observation[] = [];
  for (const group of prepared.groups) {
    signal.throwIfAborted();
    try {
      const engine = engineFactory({
        cwd: prepared.canonicalRoot,
        mode,
        managedIgnores: [],
        ruleOverrides: group.rules,
        ...(prepared.reactVersion === undefined
          ? {}
          : {
              reactVersion: prepared.reactVersion,
              reactCorrectnessConfigFactory,
            }),
      });
      const results = await engine.lintFiles([...group.files]);
      signal.throwIfAborted();
      const allowed = new Set(group.files);
      for (const result of results) {
        const path = relative(prepared.canonicalRoot, result.filePath)
          .split(sep)
          .join("/");
        if (!allowed.has(path)) throw new Error("Unexpected ESLint result.");
        observations.push(
          ...result.messages.map((message) =>
            convertEslintMessage(path, message, prepared.canonicalRoot, id),
          ),
        );
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof CheckIncompleteError) throw error;
      throw reactAnalysisFailure(
        id,
        group.files.length === 1 ? group.files[0] : undefined,
      );
    }
  }
  return Object.freeze(
    observations.sort(
      (left, right) =>
        compareCodeUnits(left.identity, right.identity) ||
        compareCodeUnits(left.message, right.message),
    ),
  );
}

export function createReactAdapter(
  id: "reactCorrectness" | "reactAccessibility",
  mode: ManagedEslintMode,
  reactCorrectnessConfigFactory: ReactCorrectnessConfigFactory = managedReactCorrectnessConfig,
  engineFactory: ReactEslintEngineFactory = createManagedEslint,
  reactVersionResolverFactory: ReactVersionResolverFactory = createReactVersionResolver,
): ObservationCheckAdapter {
  const baselineVersionResolvers = new WeakMap<
    RepositoryInspection,
    Promise<ReactVersionResolver>
  >();
  const targetVersionResolvers = new WeakMap<
    RepositoryInspection,
    Promise<ReactVersionResolver>
  >();
  const cachedWorkspaceResolver = (
    resolvers: WeakMap<RepositoryInspection, Promise<ReactVersionResolver>>,
  ): ResolveWorkspaceReactVersion => {
    return async (inspection, workspace) => {
      let resolver = resolvers.get(inspection);
      if (resolver === undefined) {
        resolver = reactVersionResolverFactory(inspection);
        resolvers.set(inspection, resolver);
      }
      const resolveVersion = await resolver;
      return (await resolveVersion(workspace)).version;
    };
  };
  const resolveBaselineReactVersion = cachedWorkspaceResolver(
    baselineVersionResolvers,
  );
  const resolveTargetReactVersion = cachedWorkspaceResolver(
    targetVersionResolvers,
  );
  return {
    id,
    output: "observations",
    inspect: (context: import("../adapter.js").InspectionContext) =>
      inspectManagedCheck(id, context),
    ...(id === "reactCorrectness"
      ? {
          async planFixes(context: CheckRunContext, findings) {
            const prepared = await prepareSide(
              context.snapshots.targetDir,
              context.targetInspection,
              context.target,
              id,
              mode,
              resolveTargetReactVersion,
              "target",
              context.policyForFile,
              context.signal,
            );
            if (prepared === undefined) return Object.freeze([]);
            const candidates: Awaited<
              ReturnType<typeof planManagedEslintFixes>
            >[number][] = [];
            for (const group of prepared.groups) {
              context.signal.throwIfAborted();
              try {
                candidates.push(
                  ...(await planManagedEslintFixes(
                    {
                      context,
                      checkId: "reactCorrectness",
                      files: group.files,
                      createEngine: () =>
                        engineFactory({
                          cwd: prepared.canonicalRoot,
                          mode,
                          managedIgnores: [],
                          ruleOverrides: group.rules,
                          ...(prepared.reactVersion === undefined
                            ? {}
                            : {
                                reactVersion: prepared.reactVersion,
                                reactCorrectnessConfigFactory,
                              }),
                        }),
                    },
                    findings,
                  )),
                );
              } catch (error) {
                context.signal.throwIfAborted();
                if (error instanceof CheckIncompleteError) throw error;
                throw reactAnalysisFailure(
                  "reactCorrectness",
                  group.files.length === 1 ? group.files[0] : undefined,
                );
              }
            }
            return Object.freeze(candidates);
          },
        }
      : {}),
    async collect(context: CheckRunContext): Promise<CheckObservationSet> {
      const collectBaseline = await prepareSide(
        context.snapshots.baselineDir,
        context.baselineInspection,
        context.target,
        id,
        mode,
        resolveBaselineReactVersion,
        "baseline",
        context.policyForFile,
        context.signal,
      );
      const collectTarget = await prepareSide(
        context.snapshots.targetDir,
        context.targetInspection,
        context.target,
        id,
        mode,
        resolveTargetReactVersion,
        "target",
        context.policyForFile,
        context.signal,
      );
      const [baselineObservations, targetObservations] =
        await settleSnapshotSides(
          () =>
            collectPreparedSide(
              collectBaseline,
              id,
              mode,
              reactCorrectnessConfigFactory,
              engineFactory,
              context.signal,
            ),
          () =>
            collectPreparedSide(
              collectTarget,
              id,
              mode,
              reactCorrectnessConfigFactory,
              engineFactory,
              context.signal,
            ),
          context.signal,
          isAnalyzerWorker(),
        );
      return {
        checkId: id,
        target: context.target,
        baselineObservations,
        targetObservations,
      };
    },
  };
}
