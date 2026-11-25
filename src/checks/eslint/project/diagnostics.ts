import { createHash } from "node:crypto";
import { normalizeRepositoryRelativePath } from "../../../attribution/fingerprint.js";
import type { Observation } from "../../../core/types.js";
import { DISPLAY_TEXT_LIMITS } from "../../../core/display-text.js";

export interface ProjectDiagnostic {
  readonly file: string;
  readonly ruleId: string | null;
  readonly severity: 1 | 2;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly fatal?: boolean;
  readonly comparisonIdentity?: string;
}
export function convertProjectEslintDiagnostic(
  input: ProjectDiagnostic,
  fullMessages: boolean,
): Observation {
  const file = normalizeRepositoryRelativePath(input.file);
  const rule = input.fatal
    ? "eslint/parsing-error"
    : (input.ruleId ?? "eslint/configuration");
  if (!rule || rule.length > 200 || /[\p{Cc}\p{Cf}]/u.test(rule))
    throw new TypeError("Invalid project rule identity");
  const location = {
    file,
    ...Object.fromEntries(
      (
        [
          ["startLine", input.line],
          ["startColumn", input.column],
          ["endLine", input.endLine],
          ["endColumn", input.endColumn],
        ] as const
      ).filter(
        (entry): entry is readonly [(typeof entry)[0], number] =>
          Number.isSafeInteger(entry[1]) && entry[1]! > 0,
      ),
    ),
  };
  const message = fullMessages
    ? input.message
        .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
        .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s'"`<>]+/gu, "<path>")
        .slice(0, DISPLAY_TEXT_LIMITS.prose)
        .replace(/[\uD800-\uDBFF]$/u, "")
    : "Project ESLint reported a diagnostic.";
  return {
    check: "lint",
    rule,
    identity: JSON.stringify([rule, location]),
    severity: input.severity === 1 ? "warning" : "error",
    message,
    location,
    comparisonIdentity:
      input.comparisonIdentity ??
      createHash("sha256").update(input.message).digest("hex"),
  };
}
