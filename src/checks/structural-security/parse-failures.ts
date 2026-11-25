import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";
import type { StructuralParseFailures } from "../../core/types.js";
import { typescriptDiagnosticMessage } from "../typescript/diagnostic-message.js";

export const MAX_STRUCTURAL_PARSE_FAILURES = 256;

const EXPECTED_TOKENS = new Set([
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ";",
  ",",
  ".",
  ":",
  "?",
  "=",
  "<",
  ">",
  "=>",
  "...",
  "as",
  "from",
  "in",
  "of",
]);

export function safeExpectedToken(
  value: string | undefined,
): string | undefined {
  return value !== undefined && EXPECTED_TOKENS.has(value) ? value : undefined;
}

export function structuralParseReason(
  typescriptCode?: number,
  expectedToken?: string,
): string {
  if (typescriptCode === undefined)
    return "The structural parser could not recognize this syntax.";
  if (typescriptCode === 1005)
    return expectedToken === undefined
      ? "TypeScript expected another token."
      : `'${expectedToken}' expected.`;
  if (typescriptCode === 17002)
    return "Expected a corresponding JSX closing tag.";
  return typescriptDiagnosticMessage(typescriptCode).slice(0, 512);
}

export function sanitizeStructuralParseFailures(
  value: StructuralParseFailures,
): StructuralParseFailures {
  if (
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_STRUCTURAL_PARSE_FAILURES ||
    !Number.isSafeInteger(value.omitted) ||
    value.omitted < 0
  )
    throw new TypeError("Invalid structural parse failures");
  return Object.freeze({
    omitted: value.omitted,
    files: Object.freeze(
      value.files.map((file) => {
        const { line, column, snapshot, typescriptCode } = file;
        if (
          !Number.isSafeInteger(line) ||
          line < 1 ||
          !Number.isSafeInteger(column) ||
          column < 1 ||
          (snapshot !== "baseline" &&
            snapshot !== "staged" &&
            snapshot !== "target") ||
          (typescriptCode !== undefined &&
            (!Number.isSafeInteger(typescriptCode) || typescriptCode < 1))
        )
          throw new TypeError("Invalid structural parse failure");
        const expectedToken =
          typescriptCode === 1005
            ? safeExpectedToken(file.expectedToken)
            : undefined;
        return Object.freeze({
          path: normalizeRepositoryRelativePath(file.path),
          snapshot,
          line,
          column,
          ...(typescriptCode === undefined ? {} : { typescriptCode }),
          ...(expectedToken === undefined ? {} : { expectedToken }),
          reason: structuralParseReason(typescriptCode, expectedToken),
        });
      }),
    ),
  });
}
