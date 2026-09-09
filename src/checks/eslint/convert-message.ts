import type { Linter } from "eslint";
import type {
  Observation,
  Severity,
  SourceLocation,
} from "../../core/types.js";
import { managedAutomaticFixFor } from "../../attribution/fingerprint.js";
import { DISPLAY_TEXT_LIMITS } from "../../core/display-text.js";

const TRUNCATION_MARKER = "... [truncated]";
const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function sanitizeMessage(message: string, snapshotRoot: string): string {
  const redacted = message
    .split(snapshotRoot)
    .join("<snapshot>")
    .replaceAll("\\", "/")
    .replace(/(^|[\s("'`])(?:[A-Za-z]:\/|\/)[^\s'"`<>]+/gu, "$1<path>");
  const [summary = ""] = redacted.split(/\r?\n\s*\r?\n/u, 1);
  const safe = summary
    .replaceAll(UNSAFE_DISPLAY_CHARACTER, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (safe.length <= DISPLAY_TEXT_LIMITS.prose) return safe;
  let prefix = safe.slice(
    0,
    DISPLAY_TEXT_LIMITS.prose - TRUNCATION_MARKER.length,
  );
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}${TRUNCATION_MARKER}`;
}

function location(file: string, message: Linter.LintMessage): SourceLocation {
  const startLine = positiveInteger(message.line);
  const startColumn = positiveInteger(message.column);
  const endLine = positiveInteger(message.endLine);
  const endColumn = positiveInteger(message.endColumn);
  return {
    file,
    ...(startLine === undefined ? {} : { startLine }),
    ...(startColumn === undefined ? {} : { startColumn }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(endColumn === undefined ? {} : { endColumn }),
  };
}

function identity(rule: string, value: SourceLocation): string {
  const range = [
    value.startLine,
    value.startColumn,
    value.endLine,
    value.endColumn,
  ].filter((part): part is number => part !== undefined);
  return `${rule}:${value.file}${range.length === 0 ? "" : `:${range.join(":")}`}`;
}

export function convertEslintMessage(
  repositoryPath: string,
  message: Linter.LintMessage,
  snapshotRoot: string,
  check = "lint",
): Observation {
  const rule = message.fatal
    ? "eslint/parsing-error"
    : (message.ruleId ?? "eslint/unknown");
  const severity: Severity = message.severity === 1 ? "warning" : "error";
  const normalizedLocation = location(repositoryPath, message);
  const automaticFix =
    message.fix === undefined ? undefined : managedAutomaticFixFor(check);
  return {
    check,
    rule,
    identity: identity(rule, normalizedLocation),
    severity,
    message: sanitizeMessage(message.message, snapshotRoot),
    location: normalizedLocation,
    ...(automaticFix === undefined ? {} : { automaticFix }),
  };
}
