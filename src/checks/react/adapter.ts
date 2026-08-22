import { relative, sep } from "node:path";
import type { ESLint } from "eslint";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import { canonicalizeSnapshotRoot } from "../../inspection/read-json.js";
import type {
  Environment,
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
import {
  createReactVersionResolver,
  type ReactVersionResolver,
} from "./version.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const REACT_ENVIRONMENTS = new Set<Environment>([
  "react",
  "react-dom",
  "ink",
  "next",
  "remix",
]);
const DOM_ENVIRONMENTS = new Set<Environment>(["react-dom", "next", "remix"]);

type ReactEslintEngineFactory = (
  options: ManagedEslintOptions,
) => Pick<ESLint, "lintFiles">;

type PreparedSide = () => Promise<readonly Observation[]>;

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

function targetFor(workspace: WorkspaceInspection): CheckTarget {
  return {
    id: workspace.relativeRoot,
    kind: "workspace",
    relativeRoot: workspace.relativeRoot,
  };
}

function hasEnvironment(
  workspace: WorkspaceInspection,
  allowed: ReadonlySet<Environment>,
): boolean {
  return workspace.environments.some((environment) => allowed.has(environment));
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
  reactCorrectnessConfigFactory: ReactCorrectnessConfigFactory,
  engineFactory: ReactEslintEngineFactory,
  resolveWorkspaceReactVersion: ResolveWorkspaceReactVersion,
  side: SnapshotSide,
  policyForFile: FilePolicyResolver,
): Promise<PreparedSide> {
  const failure =
    id === "reactCorrectness"
      ? "React correctness analysis failed."
      : "React accessibility analysis failed.";
  try {
    const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
    if (canonicalRoot !== inspection.snapshotRoot) throw new Error(failure);
    const workspace = workspaceFor(inspection, target);
    if (workspace === undefined) {
      return async () => Object.freeze([]);
    }
    const files = workspace.sourceFiles
      .filter((path) => SOURCE.test(path))
      .sort(compareCodeUnits);
    if (files.length === 0) {
      return async () => Object.freeze([]);
    }
    const groups = groupFilesByRules(files, side, policyForFile, id);
    if (groups.length === 0) {
      return async () => Object.freeze([]);
    }

    const reactVersion =
      mode === "react-correctness"
        ? await resolveWorkspaceReactVersion(inspection, workspace)
        : undefined;

    const preparedGroups = groups.map((group) => {
      try {
        return {
          group,
          engine: engineFactory({
            cwd: canonicalRoot,
            mode,
            managedIgnores: [],
            ruleOverrides: group.rules,
            ...(reactVersion === undefined
              ? {}
              : { reactVersion, reactCorrectnessConfigFactory }),
          }),
        };
      } catch {
        throw reactAnalysisFailure(
          id,
          group.files.length === 1 ? group.files[0] : undefined,
        );
      }
    });
    return async () => {
      try {
        const collected = await Promise.all(
          preparedGroups.map(async ({ group, engine }) => {
            try {
              const results = await engine.lintFiles([...group.files]);
              const allowed = new Set(group.files);
              const observations: Observation[] = [];
              for (const result of results) {
                const path = relative(canonicalRoot, result.filePath)
                  .split(sep)
                  .join("/");
                if (!allowed.has(path)) throw new Error(failure);
                observations.push(
                  ...result.messages.map((message) =>
                    convertEslintMessage(path, message, canonicalRoot, id),
                  ),
                );
              }
              return observations;
            } catch (error) {
              if (error instanceof CheckIncompleteError) throw error;
              throw reactAnalysisFailure(
                id,
                group.files.length === 1 ? group.files[0] : undefined,
              );
            }
          }),
        );
        const observations = collected.flat();
        return Object.freeze(
          observations.sort(
            (left, right) =>
              compareCodeUnits(left.identity, right.identity) ||
              compareCodeUnits(left.message, right.message),
          ),
        );
      } catch (error) {
        if (error instanceof CheckIncompleteError) throw error;
        throw new Error(failure);
      }
    };
  } catch (error) {
    if (error instanceof CheckIncompleteError) throw error;
    throw new Error(failure);
  }
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
  const environments =
    id === "reactAccessibility" ? DOM_ENVIRONMENTS : REACT_ENVIRONMENTS;
  return {
    id,
    output: "observations",
    async inspect(context) {
      const eligible = context.targetInspection.workspaces.filter((workspace) =>
        hasEnvironment(workspace, environments),
      );
      if (eligible.length === 0) {
        return {
          applies: false,
          reason:
            id === "reactAccessibility"
              ? "No browser DOM renderer detected"
              : "No React renderer detected",
        };
      }
      const changed = new Set(
        [...context.changeSet.files.values()]
          .filter(({ status }) => status !== "deleted")
          .map(({ path }) => path),
      );
      const workspaces = eligible.filter((workspace) =>
        workspace.sourceFiles.some(
          (path) =>
            SOURCE.test(path) &&
            (context.config.checks[id].when === "always" || changed.has(path)),
        ),
      );
      if (workspaces.length === 0) {
        return { applies: false, reason: "No supported staged source files" };
      }
      return {
        applies: true,
        executionClass: "lightweight",
        requiresBaseline: true,
        targets: workspaces.map(targetFor),
      };
    },
    async collect(context: CheckRunContext): Promise<CheckObservationSet> {
      const collectBaseline = await prepareSide(
        context.snapshots.baselineDir,
        context.baselineInspection,
        context.target,
        id,
        mode,
        reactCorrectnessConfigFactory,
        engineFactory,
        resolveBaselineReactVersion,
        "baseline",
        context.policyForFile,
      );
      const collectTarget = await prepareSide(
        context.snapshots.targetDir,
        context.targetInspection,
        context.target,
        id,
        mode,
        reactCorrectnessConfigFactory,
        engineFactory,
        resolveTargetReactVersion,
        "target",
        context.policyForFile,
      );
      const [baselineObservations, targetObservations] = await Promise.all([
        collectBaseline(),
        collectTarget(),
      ]);
      return {
        checkId: id,
        target: context.target,
        baselineObservations,
        targetObservations,
      };
    },
  };
}
