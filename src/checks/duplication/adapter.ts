import { findWorkspace } from "../../inspection/workspaces.js";
import { inspectManagedCheck } from "../applicability.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execa } from "execa";
import { isAnalyzerWorker } from "../runner/context.js";
import { AnalyzerJobError, analyzerDiagnostic } from "../diagnostics.js";
import { duplicationInputPaths } from "./input-paths.js";
import type { NormalizedDuplicationReport } from "./types.js";
import { loadDuplicationSources } from "./source-tokens.js";
import { forEachConcurrently } from "./concurrency.js";
import { compareCloneOccurrences } from "./clone-comparison.js";
import { canonicalizeSnapshotRoot } from "../../inspection/read-json.js";
import { digestContainedLineRange } from "../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import type { SnapshotRegistry } from "../../inspection/snapshot-registry.js";
import type { RepositoryInspection } from "../../inspection/types.js";
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
import {
  isPercentage,
  missingCloneFragmentLocations,
  parseJscpdReport,
} from "./normalize-clone.js";
import { jscpdOptions } from "./settings.js";
import type { ResolvedDuplicationPolicy } from "../../config/schema.js";

const FALLBACK_DIGEST_CONCURRENCY = 4;

type MissingFragment = ReturnType<typeof missingCloneFragmentLocations>[number];

export async function createFallbackTokenHashes(
  registry: SnapshotRegistry,
  missingFragments: readonly MissingFragment[],
  digest: typeof digestContainedLineRange = digestContainedLineRange,
): Promise<ReadonlyMap<number, string>> {
  const uniqueRanges = new Map<
    string,
    {
      readonly location: MissingFragment["location"];
      readonly indexes: number[];
    }
  >();
  for (const { index, location } of missingFragments) {
    const key = JSON.stringify([
      location.file,
      location.startLine,
      location.endLine,
    ]);
    const existing = uniqueRanges.get(key);
    if (existing === undefined) {
      uniqueRanges.set(key, { location, indexes: [index] });
    } else {
      existing.indexes.push(index);
    }
  }

  const ranges = [...uniqueRanges.values()];
  const hashes = new Map<number, string>();
  await forEachConcurrently(
    ranges,
    FALLBACK_DIGEST_CONCURRENCY,
    async (range) => {
      const hash = await digest(
        registry,
        range.location.file,
        range.location.startLine,
        range.location.endLine,
      );
      for (const index of range.indexes) hashes.set(index, hash);
    },
  );
  return hashes;
}

const JSCPD_REPORT = "jscpd-report.json";

function threshold(policyThreshold: number | undefined): number {
  if (!isPercentage(policyThreshold)) {
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
  settings: ReturnType<typeof jscpdOptions>,
  signal: AbortSignal,
): Promise<{
  report: NormalizedDuplicationReport;
  files: readonly string[];
  root: string;
}> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (canonicalRoot !== inspection.snapshotRoot) {
    throw new Error("Duplication analysis failed.");
  }
  const workspace = findWorkspace(inspection, target.relativeRoot);
  if (workspace === undefined)
    return {
      report: { percentage: 0, clones: [] },
      files: [],
      root: canonicalRoot,
    };
  const sourceFiles = await duplicationInputPaths(inspection, workspace);
  if (sourceFiles.length === 0)
    return {
      report: { percentage: 0, clones: [] },
      files: [],
      root: canonicalRoot,
    };

  const output = await createManagedOutputDirectory("jscpd", [JSCPD_REPORT]);
  try {
    const managed = await writeManagedJsonConfig("jscpd", {
      ...jscpdOptions(settings),
      format: ["javascript", "jsx", "typescript", "tsx"],
      reporters: ["json"],
      output: output.path,
      threshold: policyThreshold,
      silent: true,
      gitignore: true,
      // Explicit file arguments can otherwise yield ambiguous report basenames.
      absolute: true,
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
          killDescendants: !isAnalyzerWorker(),
          cancelSignal: signal,
        },
      );
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error("Duplication analysis failed.", {
          cause: new AnalyzerJobError(
            analyzerDiagnostic(
              "duplication",
              "collect",
              "abnormal-exit",
              result.exitCode,
              result.signal,
            ),
          ),
        });
      }
      const rawReport = await output.readJson(JSCPD_REPORT);
      const missingFragments = missingCloneFragmentLocations(
        rawReport,
        canonicalRoot,
        workspace.relativeRoot,
        sourceFiles,
      );
      const allowed = new Set(sourceFiles);
      if (
        missingFragments.some(({ location }) => !allowed.has(location.file))
      ) {
        throw new Error("Duplication analysis failed.");
      }
      let fallbackTokenHashes: ReadonlyMap<number, string> = new Map();
      if (missingFragments.length > 0) {
        const registry = await captureSnapshotRegistry(canonicalRoot);
        fallbackTokenHashes = await createFallbackTokenHashes(
          registry,
          missingFragments,
        );
      }
      const report = parseJscpdReport(
        rawReport,
        canonicalRoot,
        workspace.relativeRoot,
        sourceFiles,
        fallbackTokenHashes,
      );
      if (
        report.clones.some((clone) =>
          clone.fragments.some(({ file }) => !allowed.has(file)),
        )
      ) {
        throw new Error("Duplication analysis failed.");
      }
      return { report, files: sourceFiles, root: canonicalRoot };
    } finally {
      await managed.cleanup();
    }
  } finally {
    await output.cleanup();
  }
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

export const duplicationAdapter: ObservationCheckAdapter = {
  id: "duplication",
  output: "observations",
  inspect: (context: import("../adapter.js").InspectionContext) =>
    inspectManagedCheck("duplication", context),
  async collect(context: CheckRunContext): Promise<CheckObservationSet> {
    try {
      const policy = context.policy as ResolvedDuplicationPolicy;
      const policyThreshold = threshold(policy.threshold);
      const [baselineResult, targetResult] = await Promise.allSettled([
        collectSide(
          context.snapshots.baselineDir,
          context.baselineInspection,
          context.target,
          policyThreshold,
          policy.settings,
          context.signal,
        ),
        collectSide(
          context.snapshots.targetDir,
          context.targetInspection,
          context.target,
          policyThreshold,
          policy.settings,
          context.signal,
        ),
      ]);
      const baseline = settledValue(baselineResult);
      const target = settledValue(targetResult);
      if (
        target.report.percentage <= policyThreshold ||
        target.report.clones.length === 0
      ) {
        return {
          checkId: "duplication",
          target: context.target,
          baselineObservations: [],
          targetObservations: [],
        };
      }
      const fullInventory = baseline.report.percentage <= policyThreshold;
      const fragmentFiles = (report: NormalizedDuplicationReport): string[] => [
        ...new Set(
          report.clones.flatMap((clone) =>
            clone.fragments.map(({ file }) => file),
          ),
        ),
      ];
      const baselineFiles = fullInventory
        ? baseline.files
        : fragmentFiles(baseline.report);
      const targetFiles = fullInventory
        ? target.files
        : fragmentFiles(target.report);
      const [baselineRegistry, targetRegistry] = await Promise.all([
        captureSnapshotRegistry(baseline.root, baselineFiles),
        captureSnapshotRegistry(target.root, targetFiles),
      ]);
      const [baselineSources, targetSources] = await Promise.all([
        loadDuplicationSources(
          baselineRegistry,
          baselineFiles,
          policy.settings,
          context.signal,
        ),
        loadDuplicationSources(
          targetRegistry,
          targetFiles,
          policy.settings,
          context.signal,
        ),
      ]);
      const { baselineObservations, targetObservations } =
        compareCloneOccurrences(
          baseline.report,
          target.report,
          baselineSources,
          targetSources,
          context.changeSet,
          policyThreshold,
          policy.settings.mode,
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
