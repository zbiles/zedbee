import type { Linter } from "eslint";
import type {
  Observation,
  Severity,
  SourceLocation,
} from "../../core/types.js";

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function sanitizeMessage(message: string, snapshotRoot: string): string {
  return message
    .split(snapshotRoot)
    .join("<snapshot>")
    .replaceAll("\\", "/")
    .replace(/(^|[\s("'`])(?:[A-Za-z]:\/|\/)[^\s'"`<>]+/gu, "$1<path>");
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
  return {
    check,
    rule,
    identity: identity(rule, normalizedLocation),
    severity,
    message: sanitizeMessage(message.message, snapshotRoot),
    location: normalizedLocation,
  };
}
