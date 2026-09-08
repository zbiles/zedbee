import { inspectManagedCheck } from "../applicability.js";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import * as ts from "typescript";
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
import { CheckIncompleteError } from "../incomplete-error.js";
import { collectStructuralSecurityObservations } from "./rules.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/iu;

function parserCompatibleTypeScriptSource(
  file: string,
  source: string,
): string {
  if (!TYPESCRIPT_SOURCE.test(file)) throw new Error("parse failed");
  const transpiled = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
    },
  });
  if (
    transpiled.diagnostics?.some(
      ({ category }) => category === ts.DiagnosticCategory.Error,
    )
  ) {
    throw new Error("parse failed");
  }

  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const importTypes: ts.ImportTypeNode[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) importTypes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (importTypes.length === 0) throw new Error("parse failed");

  let compatible = source;
  for (const node of importTypes.sort((left, right) => right.pos - left.pos)) {
    const start = node.getStart(parsed);
    const end = node.getEnd();
    const original = source.slice(start, end);
    const placeholder = `any${original
      .slice(3)
      .replace(/[^\r\n\u2028\u2029]/g, " ")}`;
    compatible = `${compatible.slice(0, start)}${placeholder}${compatible.slice(end)}`;
  }
  return compatible;
}

function collectFile(file: string, source: string): readonly Observation[] {
  try {
    return collectStructuralSecurityObservations(file, source);
  } catch {
    return collectStructuralSecurityObservations(
      file,
      parserCompatibleTypeScriptSource(file, source),
    );
  }
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
  signal: AbortSignal,
  side: "baseline" | "staged",
): Promise<readonly Observation[]> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (canonicalRoot !== inspection.snapshotRoot)
    throw new Error("Structural security analysis failed.");
  const workspace = workspaceFor(inspection, target);
  if (workspace === undefined) return Object.freeze([]);
  const files = workspace.sourceFiles
    .filter((file) => SOURCE.test(file))
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
      observations.push(...collectFile(file, source));
    } catch {
      throw new CheckIncompleteError({
        code: "STRUCTURAL_SECURITY_PARSE_FAILED",
        message: `Structural security could not parse a ${side} source file.`,
        path: file,
        remediation:
          "Verify that this file uses valid JavaScript or TypeScript syntax, then retry. If the project accepts this syntax, report a Zedbee parser compatibility issue.",
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
      const baselineObservations = await collectSide(
        context.snapshots.baselineDir,
        context.baselineInspection,
        context.target,
        context.signal,
        "baseline",
      );
      const targetObservations = await collectSide(
        context.snapshots.targetDir,
        context.targetInspection,
        context.target,
        context.signal,
        "staged",
      );
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
