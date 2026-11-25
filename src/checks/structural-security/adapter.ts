import { findWorkspace } from "../../inspection/workspaces.js";
import { inspectManagedCheck } from "../applicability.js";
import { changedFilePaths } from "../changed-file-paths.js";
import type { FilePolicyResolver } from "../../config/file-policy.js";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation, StructuralParseFailure } from "../../core/types.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import {
  capturedSourceInput,
  capturedSourceRegistry,
  hasAnalysisSourceCapture,
} from "../../inspection/source-capture.js";
import type { RepositoryInspection } from "../../inspection/types.js";
import type {
  CheckObservationSet,
  CheckRunContext,
  CheckTarget,
  ObservationCheckAdapter,
} from "../adapter.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import { collectStructuralSecurityObservations } from "./rules.js";

import { StructuralParseError } from "./parser.js";
import {
  MAX_STRUCTURAL_PARSE_FAILURES,
  structuralParseReason,
} from "./parse-failures.js";

interface FailureCollection {
  files: StructuralParseFailure[];
  omitted: number;
}

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
async function collectSide(
  snapshotRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
  signal: AbortSignal,
  side: StructuralParseFailure["snapshot"],
  selectedPaths: ReadonlySet<string>,
  policyForFile: FilePolicyResolver,
  failures: FailureCollection,
): Promise<readonly Observation[]> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (canonicalRoot !== inspection.snapshotRoot)
    throw new Error("Structural security analysis failed.");
  const workspace = findWorkspace(inspection, target.relativeRoot);
  const candidates = new Set(workspace?.sourceFiles ?? []);
  if (side === "baseline") {
    for (const owner of inspection.workspaces) {
      for (const file of owner.sourceFiles) {
        if (selectedPaths.has(file)) candidates.add(file);
      }
    }
  }
  const files = [...candidates]
    .filter((file) => SOURCE.test(file))
    .filter(
      (file) =>
        selectedPaths.has(file) ||
        policyForFile(
          "structuralSecurity",
          file,
          side === "baseline" ? "baseline" : "target",
        ).when === "always",
    )
    .sort(compareCodeUnits);
  const liveRegistry = await captureSnapshotRegistry(
    canonicalRoot,
    hasAnalysisSourceCapture()
      ? files.filter(
          (file) => capturedSourceInput(canonicalRoot, file) === undefined,
        )
      : undefined,
  );
  const observations: Observation[] = [];
  for (const file of files) {
    if (signal.aborted) throw new Error("Structural security analysis failed.");
    const source = await readContainedFile(
      capturedSourceRegistry(canonicalRoot, [file]) ?? liveRegistry,
      file,
    );
    try {
      observations.push(...collectStructuralSecurityObservations(file, source));
    } catch (error) {
      if (!(error instanceof StructuralParseError)) throw error;
      if (failures.files.length === MAX_STRUCTURAL_PARSE_FAILURES) {
        failures.omitted++;
        continue;
      }
      failures.files.push({
        path: file,
        snapshot: side,
        ...error.position,
        reason: structuralParseReason(
          error.position.typescriptCode,
          error.position.expectedToken,
        ),
      });
    }
  }
  return Object.freeze(
    observations.sort((left, right) =>
      compareCodeUnits(left.identity, right.identity),
    ),
  );
}

export const structuralSecurityAdapter: ObservationCheckAdapter = {
  id: "structuralSecurity",
  output: "observations",
  inspect: (context: import("../adapter.js").InspectionContext) =>
    inspectManagedCheck("structuralSecurity", context),
  async collect(context: CheckRunContext): Promise<CheckObservationSet> {
    try {
      const failures: FailureCollection = { files: [], omitted: 0 };
      const baselineObservations = await collectSide(
        context.snapshots.baselineDir,
        context.baselineInspection,
        context.target,
        context.signal,
        "baseline",
        changedFilePaths(context, "baseline"),
        context.policyForFile,
        failures,
      );
      const targetObservations = await collectSide(
        context.snapshots.targetDir,
        context.targetInspection,
        context.target,
        context.signal,
        context.snapshots.targetRef === "index" ? "staged" : "target",
        changedFilePaths(context, "target"),
        context.policyForFile,
        failures,
      );
      if (context.signal.aborted)
        throw new Error("Structural security analysis failed.");
      const first = failures.files[0];
      if (first !== undefined) {
        const count = failures.files.length + failures.omitted;
        const side = first.snapshot;
        throw new CheckIncompleteError({
          code: "STRUCTURAL_SECURITY_PARSE_FAILED",
          message:
            count === 1
              ? `Structural security could not parse a ${side} source file.`
              : `Structural security could not parse ${count} source file versions.`,
          path: first.path,
          paths: failures.files.map(({ path }) => path),
          parseFailures: failures,
          remediation:
            "Verify that this file uses valid JavaScript or TypeScript syntax, then retry. If the project accepts this syntax, report a Zedbee parser compatibility issue.",
        });
      }
      return {
        checkId: "structuralSecurity",
        target: context.target,
        baselineObservations,
        targetObservations,
      };
    } catch (error) {
      if (error instanceof CheckIncompleteError) throw error;
      throw new Error("Structural security analysis failed.");
    }
  },
};
