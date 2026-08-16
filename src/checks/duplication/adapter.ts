import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execa } from "execa";
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
import {
  createManagedOutputDirectory,
  writeManagedJsonConfig,
} from "../project/config-boundary.js";
import { cloneObservations, parseJscpdReport } from "./normalize-clone.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const JSCPD_REPORT = "jscpd-report.json";

function targetFor(workspace: WorkspaceInspection): CheckTarget {
  return {
    id: workspace.relativeRoot,
    kind: "workspace",
    relativeRoot: workspace.relativeRoot,
  };
}

function workspaceFor(
  inspection: RepositoryInspection,
  target: CheckTarget,
): WorkspaceInspection | undefined {
  return inspection.workspaces.find(
    ({ relativeRoot }) => relativeRoot === target.relativeRoot,
  );
}

function threshold(policyThreshold: number | undefined): number {
  if (
    typeof policyThreshold !== "number" ||
    !Number.isFinite(policyThreshold) ||
    policyThreshold < 0 ||
    policyThreshold > 100
  ) {
    throw new TypeError(
      "Duplication analysis requires a percentage threshold.",
    );
  }
  return policyThreshold;
}

async function collectSide(
  snapshotRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
  policyThreshold: number,
  signal: AbortSignal,
): Promise<readonly Observation[]> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (canonicalRoot !== inspection.snapshotRoot) {
    throw new Error("Duplication analysis failed.");
  }
  const workspace = workspaceFor(inspection, target);
  if (workspace === undefined) return Object.freeze([]);
  const sourceFiles = workspace.sourceFiles
    .filter((path) => SOURCE.test(path))
    .sort(compareCodeUnits);
  if (sourceFiles.length === 0) return Object.freeze([]);

  const output = await createManagedOutputDirectory("jscpd", [JSCPD_REPORT]);
  try {
    const managed = await writeManagedJsonConfig("jscpd", {
      minTokens: 50,
      minLines: 5,
      mode: "mild",
      format: ["javascript", "jsx", "typescript", "tsx"],
      reporters: ["json"],
      output: output.path,
      threshold: policyThreshold,
      silent: true,
      gitignore: true,
    });
    try {
      const cliPath = fileURLToPath(import.meta.resolve("jscpd/run-jscpd.js"));
      const result = await execa(
        process.execPath,
        [
          cliPath,
          "--config",
          managed.path,
          ...sourceFiles.map((path) => join(canonicalRoot, path)),
        ],
        {
          cwd: canonicalRoot,
          shell: false,
          reject: false,
          stdin: "ignore",
          forceKillAfterDelay: 2_000,
          cancelSignal: signal,
        },
      );
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error("Duplication analysis failed.");
      }
      const report = parseJscpdReport(
        await output.readJson(JSCPD_REPORT),
        canonicalRoot,
        workspace.relativeRoot,
        sourceFiles,
      );
      const allowed = new Set(sourceFiles);
      if (
        report.clones.some((clone) =>
          clone.fragments.some(({ file }) => !allowed.has(file)),
        )
      ) {
        throw new Error("Duplication analysis failed.");
      }
      return cloneObservations(report, policyThreshold);
    } finally {
      await managed.cleanup();
    }
  } finally {
    await output.cleanup();
  }
}

export const duplicationAdapter: ObservationCheckAdapter = {
  id: "duplication",
  output: "observations",
  async inspect(context) {
    const changed = new Set(
      [...context.changeSet.files.values()]
        .filter(({ status }) => status !== "deleted")
        .map(({ path }) => path),
    );
    const workspaces = context.targetInspection.workspaces.filter((workspace) =>
      workspace.sourceFiles.some(
        (path) =>
          SOURCE.test(path) &&
          (context.config.checks.duplication.when === "always" ||
            changed.has(path)),
      ),
    );
    return workspaces.length === 0
      ? { applies: false, reason: "No supported staged source files" }
      : {
          applies: true,
          executionClass: "project-analysis",
          requiresBaseline: true,
          targets: workspaces.map(targetFor),
        };
  },
  async collect(context: CheckRunContext): Promise<CheckObservationSet> {
    try {
      const policyThreshold = threshold(context.policy.threshold);
      const baselineObservations = await collectSide(
        context.snapshots.baselineDir,
        context.baselineInspection,
        context.target,
        policyThreshold,
        context.signal,
      );
      const targetObservations = await collectSide(
        context.snapshots.targetDir,
        context.targetInspection,
        context.target,
        policyThreshold,
        context.signal,
      );
      return {
        checkId: "duplication",
        target: context.target,
        baselineObservations,
        targetObservations,
      };
    } catch (error) {
      throw new Error("Duplication analysis failed.", { cause: error });
    }
  },
};
