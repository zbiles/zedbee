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

    const reactVersion =
      mode === "react-correctness"
        ? await resolveWorkspaceReactVersion(inspection, workspace)
        : undefined;

    const engine = engineFactory({
      cwd: canonicalRoot,
      mode,
      managedIgnores: [],
      ...(reactVersion === undefined
        ? {}
        : { reactVersion, reactCorrectnessConfigFactory }),
    });
    return async () => {
      try {
        const results = await engine.lintFiles(files);
        const allowed = new Set(files);
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
        return Object.freeze(
          observations.sort(
            (left, right) =>
              compareCodeUnits(left.identity, right.identity) ||
              compareCodeUnits(left.message, right.message),
          ),
        );
      } catch {
        throw new Error(failure);
      }
    };
  } catch {
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
