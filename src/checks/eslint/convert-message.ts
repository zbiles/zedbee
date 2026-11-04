import type { Linter } from "eslint";
import { createHash } from "node:crypto";
import type {
  Observation,
  Severity,
  SourceLocation,
} from "../../core/types.js";
import { managedAutomaticFixFor } from "../../attribution/fingerprint.js";
import { DISPLAY_TEXT_LIMITS } from "../../core/display-text.js";
import { managedRuleInventory } from "./rule-settings.js";

/** Only managed package metadata may supply source-free diagnostic prose. */
export function eslintDiagnosticMessage(
  rule: string,
  check: string,
  message?: string,
  messageId?: string,
): string {
  if (rule === "eslint/parsing-error") return "The source could not be parsed.";
  if (
    check !== "lint" &&
    check !== "reactCorrectness" &&
    check !== "reactAccessibility"
  )
    return "The analyzer reported a diagnostic.";
  try {
    const metadata = managedRuleInventory(check).get(rule)?.meta;
    const templates = Object.fromEntries(
      Object.entries(metadata?.messages ?? {}).map(([id, template]) => [
        id,
        template.replace(/\{\{[^{}]+\}\}/gu, "[source]"),
      ]),
    );
    if (messageId !== undefined && Object.hasOwn(templates, messageId))
      return templates[messageId]!;
    if (message !== undefined && Object.values(templates).includes(message))
      return message;
    return metadata?.docs?.description ?? "The analyzer reported a diagnostic.";
  } catch {
    return "The analyzer reported a diagnostic.";
  }
}

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
    ...(check === "lint"
      ? {
          comparisonIdentity: createHash("sha256")
            .update(sanitizeMessage(message.message, snapshotRoot))
            .digest("hex"),
        }
      : {}),
    severity,
    message: sanitizeMessage(
      eslintDiagnosticMessage(rule, check, message.message, message.messageId),
      snapshotRoot,
    ),
    location: normalizedLocation,
    ...(automaticFix === undefined ? {} : { automaticFix }),
  };
}
