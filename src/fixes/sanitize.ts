import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import { compareCodeUnits } from "../core/compare.js";
import { displayLabel } from "../core/display-text.js";
import type { FormattingSettings } from "../checks/prettier/settings.js";
import type {
  CheckFixCandidate,
  ExactFileFixCandidate,
  ExactFixEdit,
  FormatFileFixCandidate,
} from "./types.js";

type CandidateRecord = Record<PropertyKey, unknown>;

export interface FixCandidateScope {
  readonly checkId: string;
  readonly findingIds: readonly string[];
}

function record(value: unknown, field: string): CandidateRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected ${field} to be an object`);
  }
  return value as CandidateRecord;
}

function ownData(record: CandidateRecord, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`Expected ${field} to be an own data property`);
  }
  return descriptor.value;
}

function ownArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected ${field} to be an array`);
  }
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`Expected ${field} to contain own data values`);
    }
    items.push(descriptor.value);
  }
  return items;
}

function safeOffset(
  value: unknown,
  field: string,
  sourceLength: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > sourceLength
  ) {
    throw new TypeError(`Expected ${field} to be a safe source offset`);
  }
  return value;
}

function severity(value: unknown, field: string): "warning" | "error" {
  if (value !== "warning" && value !== "error") {
    throw new TypeError(`Expected ${field} to be warning or error`);
  }
  return value;
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      freeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}

function sanitizeEdit(value: unknown, sourceLength: number): ExactFixEdit {
  const input = record(value, "exact-file edit");
  const findingId = displayLabel(ownData(input, "findingId"), "fix finding id");
  const editSeverity = severity(ownData(input, "severity"), "fix severity");
  const start = safeOffset(ownData(input, "start"), "fix start", sourceLength);
  const end = safeOffset(ownData(input, "end"), "fix end", sourceLength);
  if (end < start) {
    throw new TypeError("Expected fix end to follow fix start");
  }
  const replacement = ownData(input, "replacement");
  if (typeof replacement !== "string") {
    throw new TypeError("Expected fix replacement to be source text");
  }
  return { findingId, severity: editSeverity, start, end, replacement };
}

function compareEdits(left: ExactFixEdit, right: ExactFixEdit): number {
  return (
    left.start - right.start ||
    left.end - right.end ||
    compareCodeUnits(left.findingId, right.findingId) ||
    compareCodeUnits(left.severity, right.severity) ||
    compareCodeUnits(left.replacement, right.replacement)
  );
}

function sanitizeExactCandidate(input: CandidateRecord): ExactFileFixCandidate {
  const checkId = ownData(input, "checkId");
  if (checkId !== "lint" && checkId !== "reactCorrectness") {
    throw new TypeError("Expected an exact-file fixable check id");
  }
  const file = normalizeRepositoryRelativePath(
    ownData(input, "file") as string,
  );
  const baseSource = ownData(input, "baseSource");
  if (typeof baseSource !== "string") {
    throw new TypeError("Expected exact-file base source text");
  }
  const edits = ownArray(ownData(input, "edits"), "exact-file edits")
    .map((edit) => sanitizeEdit(edit, baseSource.length))
    .sort(compareEdits);
  if (edits.length === 0) {
    throw new TypeError("Expected an exact-file candidate to contain edits");
  }
  for (let index = 1; index < edits.length; index += 1) {
    if ((edits[index - 1]?.end ?? 0) > (edits[index]?.start ?? 0)) {
      throw new TypeError("Expected exact-file edits not to overlap");
    }
  }
  return freeze({ kind: "exact-file", checkId, file, baseSource, edits });
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Expected ${field} to be a positive safe integer`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`Expected ${field} to be a boolean`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T {
  if (!values.includes(value as T)) {
    throw new TypeError(`Expected ${field} to be a supported value`);
  }
  return value as T;
}

function sanitizeSettings(value: unknown): Readonly<FormattingSettings> {
  const input = record(value, "format-file settings");
  return freeze({
    printWidth: positiveInteger(ownData(input, "printWidth"), "printWidth"),
    tabWidth: positiveInteger(ownData(input, "tabWidth"), "tabWidth"),
    useTabs: boolean(ownData(input, "useTabs"), "useTabs"),
    semi: boolean(ownData(input, "semi"), "semi"),
    singleQuote: boolean(ownData(input, "singleQuote"), "singleQuote"),
    quoteProps: oneOf(ownData(input, "quoteProps"), "quoteProps", [
      "as-needed",
      "consistent",
      "preserve",
    ]),
    jsxSingleQuote: boolean(ownData(input, "jsxSingleQuote"), "jsxSingleQuote"),
    trailingComma: oneOf(ownData(input, "trailingComma"), "trailingComma", [
      "all",
      "es5",
      "none",
    ]),
    bracketSpacing: boolean(ownData(input, "bracketSpacing"), "bracketSpacing"),
    bracketSameLine: boolean(
      ownData(input, "bracketSameLine"),
      "bracketSameLine",
    ),
    arrowParens: oneOf(ownData(input, "arrowParens"), "arrowParens", [
      "always",
      "avoid",
    ]),
    proseWrap: oneOf(ownData(input, "proseWrap"), "proseWrap", [
      "always",
      "never",
      "preserve",
    ]),
    endOfLine: oneOf(ownData(input, "endOfLine"), "endOfLine", [
      "lf",
      "crlf",
      "cr",
      "auto",
    ]),
    singleAttributePerLine: boolean(
      ownData(input, "singleAttributePerLine"),
      "singleAttributePerLine",
    ),
  });
}

function sanitizeFormatCandidate(
  input: CandidateRecord,
): FormatFileFixCandidate {
  if (ownData(input, "checkId") !== "formatting") {
    throw new TypeError("Expected a formatting check id");
  }
  const file = normalizeRepositoryRelativePath(
    ownData(input, "file") as string,
  );
  const findingIds = ownArray(
    ownData(input, "findingIds"),
    "format finding IDs",
  ).map((findingId) => displayLabel(findingId, "fix finding id"));
  const severities = ownArray(
    ownData(input, "severities"),
    "format severities",
  ).map((value) => severity(value, "fix severity"));
  if (findingIds.length === 0 || findingIds.length !== severities.length) {
    throw new TypeError("Expected matching format finding IDs and severities");
  }
  const settings = sanitizeSettings(ownData(input, "settings"));
  return freeze({
    kind: "format-file",
    checkId: "formatting",
    file,
    findingIds,
    severities,
    settings,
  });
}

function snapshotScope(scope: FixCandidateScope): FixCandidateScope {
  const input = record(scope, "fix candidate scope");
  return freeze({
    checkId: displayLabel(ownData(input, "checkId"), "fix check id"),
    findingIds: ownArray(
      ownData(input, "findingIds"),
      "allowed fix finding IDs",
    ).map((findingId) => displayLabel(findingId, "allowed fix finding id")),
  });
}

function validateCandidateScope(
  candidate: CheckFixCandidate,
  scope: FixCandidateScope,
): CheckFixCandidate {
  if (candidate.checkId !== scope.checkId) {
    throw new TypeError(
      "Expected fix candidate to belong to the dispatched check",
    );
  }
  const findingIds =
    candidate.kind === "exact-file"
      ? candidate.edits.map((edit) => edit.findingId)
      : candidate.findingIds;
  if (findingIds.some((findingId) => !scope.findingIds.includes(findingId))) {
    throw new TypeError(
      "Expected fix candidate findings to belong to the policy result",
    );
  }
  return candidate;
}

/**
 * Copies adapter-provided fix plans into immutable, non-display snapshots.
 * Source-bearing fields intentionally stay out of result and report contracts.
 */
export function sanitizeFixCandidates(
  candidates: readonly unknown[],
  scope: FixCandidateScope,
): readonly CheckFixCandidate[] {
  const snapshot = snapshotScope(scope);
  return freeze(
    ownArray(candidates, "fix candidates").map((candidate) => {
      const input = record(candidate, "fix candidate");
      const kind = ownData(input, "kind");
      if (kind === "exact-file") {
        return validateCandidateScope(sanitizeExactCandidate(input), snapshot);
      }
      if (kind === "format-file") {
        return validateCandidateScope(sanitizeFormatCandidate(input), snapshot);
      }
      throw new TypeError("Expected a supported fix candidate kind");
    }),
  );
}
