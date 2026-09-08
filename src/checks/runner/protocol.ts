import type { CheckId } from "../../config/schema.js";
import type { CheckResult, Finding, Observation } from "../../core/types.js";
import type { CheckFixCandidate } from "../../fixes/types.js";
import type { CheckObservationSet } from "../adapter.js";
import { sanitizeDependencyInputManifest } from "../../cache/dependency-inputs.js";
import { managedCheckMetadata } from "../metadata.js";
import {
  normalizeObservation,
  normalizeRepositoryRelativePath,
} from "../../attribution/fingerprint.js";
import { sanitizeCheckResult } from "../sanitize-result.js";
import { sanitizeCheckTarget } from "../sanitize-target.js";
import { sanitizeFixCandidates } from "../../fixes/sanitize.js";
import {
  formattingSettingsSchema,
  type FormattingSettings,
} from "../prettier/settings.js";
import type { SerializedCheckContext } from "./context.js";

export interface WorkingSourceInput {
  readonly file: string;
  readonly source: string;
  readonly settings: Readonly<FormattingSettings>;
}
export type AnalyzerRequest =
  | {
      readonly version: 1;
      readonly checkId: CheckId;
      readonly operation: "collect" | "runLegacy";
      readonly context: SerializedCheckContext;
    }
  | {
      readonly version: 1;
      readonly checkId: CheckId;
      readonly operation: "planFixes";
      readonly context: SerializedCheckContext;
      readonly findings: readonly Finding[];
    }
  | {
      readonly version: 1;
      readonly checkId: "formatting";
      readonly operation: "format-working-source";
      readonly input: WorkingSourceInput;
    };
export type AnalyzerResult<R extends AnalyzerRequest> =
  R["operation"] extends "format-working-source"
    ? string
    : R["operation"] extends "planFixes"
      ? readonly CheckFixCandidate[]
      : R["operation"] extends "runLegacy"
        ? CheckResult
        : CheckObservationSet;
export const FIX_CHECKS = new Set<CheckId>([
  "formatting",
  "lint",
  "reactCorrectness",
]);

export function validateAnalyzerRequest(request: AnalyzerRequest): void {
  if (
    !request ||
    request.version !== 1 ||
    !managedCheckMetadata(request.checkId)
  )
    throw new TypeError("Invalid analyzer request");
  const operation = request.operation;
  if (
    !(
      ["collect", "runLegacy", "planFixes", "format-working-source"] as string[]
    ).includes(operation) ||
    (operation === "collect" && request.checkId === "formatting") ||
    ((operation === "runLegacy" || operation === "format-working-source") &&
      request.checkId !== "formatting") ||
    (operation === "planFixes" && !FIX_CHECKS.has(request.checkId))
  )
    throw new TypeError("Invalid analyzer operation");
  const allowed = new Set([
    "version",
    "checkId",
    "operation",
    ...(operation === "format-working-source"
      ? ["input"]
      : operation === "planFixes"
        ? ["context", "findings"]
        : ["context"]),
  ]);
  if (Object.keys(request).some((key) => !allowed.has(key)))
    throw new TypeError("Invalid analyzer request fields");
  if (operation === "format-working-source") {
    normalizeRepositoryRelativePath(request.input.file);
    if (typeof request.input.source !== "string")
      throw new TypeError("Invalid source input");
    formattingSettingsSchema.parse(request.input.settings);
    if (
      Object.keys(request.input).some(
        (key) => !["file", "source", "settings"].includes(key),
      )
    )
      throw new TypeError("Invalid source input fields");
  } else {
    const context = request.context;
    if (
      !context ||
      typeof context.repositoryRoot !== "string" ||
      !Array.isArray(context.changeSet?.files) ||
      typeof context.changeSet.isEmpty !== "boolean" ||
      !Array.isArray(context.baselineInspection?.workspaces) ||
      !Array.isArray(context.targetInspection?.workspaces) ||
      typeof context.snapshots?.baselineDir !== "string" ||
      typeof context.snapshots.targetDir !== "string" ||
      !context.config ||
      !context.filePolicyConfig
    )
      throw new TypeError("Invalid analyzer context");
    sanitizeCheckTarget(context.target);
    if (operation === "planFixes" && !Array.isArray(request.findings))
      throw new TypeError("Invalid fix inputs");
  }
}

export function validateAnalyzerResult<R extends AnalyzerRequest>(
  request: R,
  value: unknown,
): AnalyzerResult<R> {
  let result: unknown;
  if (request.operation === "format-working-source") {
    if (typeof value !== "string")
      throw new TypeError("Invalid formatted source");
    result = value;
  } else if (request.operation === "planFixes") {
    result = sanitizeFixCandidates(value as readonly CheckFixCandidate[], {
      checkId: request.checkId,
      findingIds: request.findings.map((finding) => finding.id),
    });
  } else if (request.operation === "runLegacy") {
    const sanitized = sanitizeCheckResult(value as CheckResult);
    if (sanitized.checkId !== request.checkId)
      throw new TypeError("Invalid result check");
    result = sanitized;
  } else {
    const input = value as CheckObservationSet;
    if (
      !input ||
      input.checkId !== request.checkId ||
      !Array.isArray(input.baselineObservations) ||
      !Array.isArray(input.targetObservations) ||
      (input.projectDelta !== undefined &&
        typeof input.projectDelta !== "boolean")
    )
      throw new TypeError("Invalid observations");
    const target = sanitizeCheckTarget(input.target);
    const expected = request.context.target;
    if (
      target.id !== expected.id ||
      target.kind !== expected.kind ||
      target.relativeRoot !== expected.relativeRoot
    )
      throw new TypeError("Invalid observation target");
    const normalize = (observation: Observation) => {
      const safe = normalizeObservation(observation);
      if (safe.check !== request.checkId)
        throw new TypeError("Invalid observation check");
      return safe;
    };
    result = {
      checkId: input.checkId,
      target,
      baselineObservations: input.baselineObservations.map(normalize),
      targetObservations: input.targetObservations.map(normalize),
      ...(input.dependencyInputs === undefined
        ? {}
        : {
            dependencyInputs: sanitizeDependencyInputManifest(
              input.dependencyInputs,
            ),
          }),
      ...(input.projectDelta === undefined
        ? {}
        : { projectDelta: input.projectDelta }),
    };
  }
  return result as AnalyzerResult<R>;
}
