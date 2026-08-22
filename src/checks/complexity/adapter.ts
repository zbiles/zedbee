import { relative, sep } from "node:path";
import { Linter } from "eslint";
import type { Linter as LinterTypes } from "eslint";
import { collectMetricEntitySpans } from "../../attribution/entities.js";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import { canonicalizeSnapshotRoot } from "../../inspection/read-json.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import type {
  FilePolicyResolver,
  SnapshotSide,
} from "../../config/file-policy.js";
import type {
  CheckObservationSet,
  CheckRunContext,
  CheckTarget,
  ObservationCheckAdapter,
} from "../adapter.js";
import type { ResolvedComplexityPolicy } from "../../config/schema.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import { createManagedEslint } from "../eslint/load-engine.js";
import { managedConfig } from "../eslint/managed-config.js";
import {
  parseComplexityMetric,
  type ComplexityMetricName,
} from "./metric-message.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;

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

function positionOffset(source: string, line: number, column: number): number {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (starts[line - 1] ?? source.length) + column - 1;
}

function observationsFromMessages(
  file: string,
  source: string,
  messages: readonly LinterTypes.LintMessage[],
  limit?: number,
): readonly Observation[] {
  const spans = collectMetricEntitySpans(source, file);
  if (messages.some((message) => message.fatal === true)) {
    throw new Error("Complexity analysis failed.");
  }
  const mapped = messages.flatMap((message): Observation[] => {
    const metric = parseComplexityMetric(message);
    if (metric === undefined) return [];
    if (message.line === undefined || message.column === undefined) {
      throw new Error("Complexity analysis failed.");
    }
    const offset = positionOffset(source, message.line, message.column);
    const containing = spans
      .filter(
        ({ startOffset, endOffset }) =>
          offset >= startOffset && offset < endOffset,
      )
      .sort(
        (left, right) =>
          left.endOffset -
          left.startOffset -
          (right.endOffset - right.startOffset),
      )[0];
    const followingOnLine = spans
      .filter(
        ({ startOffset }) =>
          startOffset >= offset &&
          !source.slice(offset, startOffset).includes("\n"),
      )
      .sort((left, right) => left.startOffset - right.startOffset)[0];
    const span = containing ?? followingOnLine;
    if (span === undefined)
      throw new Error("Complexity metric had no canonical syntax entity.");
    const check =
      metric.name === "cyclomatic-complexity"
        ? "cyclomaticComplexity"
        : "readabilityComplexity";
    return [
      {
        check,
        rule: metric.name,
        identity: span.entity.identity,
        severity: "error",
        message:
          metric.name === "cyclomatic-complexity"
            ? "Cyclomatic complexity metric."
            : "Readability complexity metric.",
        entity: {
          kind: span.entity.kind,
          name: span.entity.name,
          file: span.entity.file,
        },
        metric: {
          name: metric.name,
          value: metric.value,
          ...(limit === undefined ? {} : { limit }),
        },
      },
    ];
  });
  const unique = new Map<string, Observation>();
  for (const observation of mapped) {
    const key = `${observation.check}:${observation.rule}:${observation.identity}`;
    const previous = unique.get(key);
    if (
      previous !== undefined &&
      !observation.identity.includes("/member-role=field/")
    ) {
      throw new Error(
        "Complexity metrics did not have unique canonical entities.",
      );
    }
    // ESLint can expose both a class-field initializer code path and its arrow
    // function. They are one source-level entity; retain the conservative max.
    if (
      previous === undefined ||
      (observation.metric?.value ?? 0) > (previous.metric?.value ?? 0)
    ) {
      unique.set(key, observation);
    }
  }
  return Object.freeze(
    [...unique.values()].sort(
      (left, right) =>
        compareCodeUnits(left.identity, right.identity) ||
        compareCodeUnits(left.rule, right.rule),
    ),
  );
}

export async function collectComplexityObservations(
  file: string,
  source: string,
  limit?: number,
): Promise<readonly Observation[]> {
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    source,
    [...managedConfig({ mode: "complexity", managedIgnores: [] })],
    { filename: file },
  );
  return observationsFromMessages(file, source, messages, limit);
}

async function collectSide(
  snapshotRoot: string,
  inspection: RepositoryInspection,
  target: CheckTarget,
  checkId: "cyclomaticComplexity" | "readabilityComplexity",
  metricName: ComplexityMetricName,
  policyForFile: FilePolicyResolver,
  side: SnapshotSide,
): Promise<readonly Observation[]> {
  const canonicalRoot = await canonicalizeSnapshotRoot(snapshotRoot);
  if (canonicalRoot !== inspection.snapshotRoot)
    throw new Error("Complexity analysis failed.");
  const workspace = workspaceFor(inspection, target);
  if (workspace === undefined) return Object.freeze([]);
  const files = workspace.sourceFiles
    .filter((path) => SOURCE.test(path))
    .sort(compareCodeUnits);
  if (files.length === 0) return Object.freeze([]);
  const engine = createManagedEslint({
    cwd: canonicalRoot,
    mode: "complexity",
    managedIgnores: [],
  });
  const results = await engine.lintFiles(files);
  const allowed = new Set(files);
  const observations: Observation[] = [];
  for (const result of results) {
    const file = relative(canonicalRoot, result.filePath).split(sep).join("/");
    if (!allowed.has(file)) throw new Error("Complexity analysis failed.");
    if (result.messages.length === 0) continue;
    if (result.source === undefined)
      throw new Error("Complexity analysis failed.");
    try {
      const policy = policyForFile(checkId, file, side);
      observations.push(
        ...observationsFromMessages(
          file,
          result.source,
          result.messages,
          (policy as ResolvedComplexityPolicy).max,
        ).filter(({ metric }) => metric?.name === metricName),
      );
    } catch {
      throw new CheckIncompleteError({
        code: "COMPLEXITY_FILE_ANALYSIS_FAILED",
        message:
          "Complexity analysis could not attribute metrics for a source file.",
        path: file,
        remediation:
          "Verify that the file contains valid JavaScript or TypeScript, then retry. If the project accepts the syntax, report a Zedbee analyzer compatibility issue.",
      });
    }
  }
  return Object.freeze(
    observations.sort((left, right) =>
      compareCodeUnits(left.identity, right.identity),
    ),
  );
}

function createComplexityAdapter(
  id: "cyclomaticComplexity" | "readabilityComplexity",
  metricName: ComplexityMetricName,
): ObservationCheckAdapter {
  return {
    id,
    output: "observations",
    async inspect(context) {
      const changed = new Set(
        [...context.changeSet.files.values()]
          .filter(({ status }) => status !== "deleted")
          .map(({ path }) => path),
      );
      const workspaces = context.targetInspection.workspaces.filter(
        (workspace) =>
          workspace.sourceFiles.some(
            (path) =>
              SOURCE.test(path) &&
              (context.config.checks[id].when === "always" ||
                changed.has(path)),
          ),
      );
      return workspaces.length === 0
        ? { applies: false, reason: "No supported staged source files" }
        : {
            applies: true,
            executionClass: "lightweight",
            requiresBaseline: true,
            targets: workspaces.map(targetFor),
          };
    },
    async collect(context: CheckRunContext): Promise<CheckObservationSet> {
      try {
        const [baselineObservations, targetObservations] = await Promise.all([
          collectSide(
            context.snapshots.baselineDir,
            context.baselineInspection,
            context.target,
            id,
            metricName,
            context.policyForFile,
            "baseline",
          ),
          collectSide(
            context.snapshots.targetDir,
            context.targetInspection,
            context.target,
            id,
            metricName,
            context.policyForFile,
            "target",
          ),
        ]);
        return {
          checkId: id,
          target: context.target,
          baselineObservations,
          targetObservations,
        };
      } catch (error) {
        if (error instanceof CheckIncompleteError) throw error;
        throw new Error("Complexity analysis failed.");
      }
    },
  };
}

export const cyclomaticComplexityAdapter = createComplexityAdapter(
  "cyclomaticComplexity",
  "cyclomatic-complexity",
);
export const readabilityComplexityAdapter = createComplexityAdapter(
  "readabilityComplexity",
  "readability-complexity",
);
export const complexityAdapters = Object.freeze([
  cyclomaticComplexityAdapter,
  readabilityComplexityAdapter,
]);
