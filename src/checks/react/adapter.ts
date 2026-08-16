import { relative, sep } from "node:path";
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
import { createManagedEslint } from "../eslint/load-engine.js";
import type { ManagedEslintMode } from "../eslint/managed-config.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const REACT_ENVIRONMENTS = new Set<Environment>([
  "react",
  "react-dom",
  "ink",
  "next",
  "remix",
]);
const DOM_ENVIRONMENTS = new Set<Environment>(["react-dom", "next", "remix"]);

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

async function collectSide(
  snapshotRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
  id: "reactCorrectness" | "reactAccessibility",
  mode: ManagedEslintMode,
): Promise<readonly Observation[]> {
  const failure =
    id === "reactCorrectness"
      ? "React correctness analysis failed."
      : "React accessibility analysis failed.";
  try {
    const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
    if (canonicalRoot !== inspection.snapshotRoot) throw new Error(failure);
    const workspace = workspaceFor(inspection, target);
    if (workspace === undefined) return Object.freeze([]);
    const files = workspace.sourceFiles
      .filter((path) => SOURCE.test(path))
      .sort(compareCodeUnits);
    if (files.length === 0) return Object.freeze([]);

    const engine = createManagedEslint({
      cwd: canonicalRoot,
      mode,
      managedIgnores: [],
    });
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
}

export function createReactAdapter(
  id: "reactCorrectness" | "reactAccessibility",
  mode: ManagedEslintMode,
): ObservationCheckAdapter {
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
      const [baselineObservations, targetObservations] = await Promise.all([
        collectSide(
          context.snapshots.baselineDir,
          context.baselineInspection,
          context.target,
          id,
          mode,
        ),
        collectSide(
          context.snapshots.targetDir,
          context.targetInspection,
          context.target,
          id,
          mode,
        ),
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
