import { createHash, createHmac } from "node:crypto";
import type { SecretLintCoreResultMessage } from "@secretlint/types";
import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";
import { compareCodeUnits } from "../../core/compare.js";
import { displayLabel } from "../../core/display-text.js";
import type { Observation } from "../../core/types.js";

const INVALID_RESULT = "Secretlint returned an invalid result";

export interface NormalizeSecretlintInput {
  readonly messages: readonly SecretLintCoreResultMessage[];
  readonly source: string;
  readonly reportPath: string;
  readonly identityPath: string;
  readonly comparisonKey: Uint8Array;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(INVALID_RESULT);
  return value;
}

function column(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(INVALID_RESULT);
  return value + 1;
}

export function normalizeSecretlintMessages(
  input: NormalizeSecretlintInput,
): readonly Observation[] {
  try {
    const reportPath = normalizeRepositoryRelativePath(input.reportPath);
    const identityPath = normalizeRepositoryRelativePath(input.identityPath);
    const observations = input.messages.map((message): Observation => {
      const rule = displayLabel(message.ruleId, "Secretlint rule id");
      const [start, end] = message.range;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > input.source.length
      ) {
        throw new TypeError(INVALID_RESULT);
      }
      const location = Object.freeze({
        file: reportPath,
        startLine: positiveInteger(message.loc.start.line),
        startColumn: column(message.loc.start.column),
        endLine: positiveInteger(message.loc.end.line),
        endColumn: column(message.loc.end.column),
      });
      const identityLocation = { ...location, file: identityPath };
      const identity = createHash("sha256")
        .update(JSON.stringify([rule, identityLocation]))
        .digest("hex");
      const comparisonIdentity = createHmac("sha256", input.comparisonKey)
        .update(input.source.slice(start, end), "utf8")
        .digest("hex");
      return Object.freeze({
        check: "secrets",
        rule,
        identity,
        comparisonIdentity,
        severity: "error",
        message: `Potential secret detected by Secretlint rule ${rule}.`,
        location,
        remediation:
          "Remove the secret, rotate the credential, and commit only a safe reference.",
      });
    });
    return Object.freeze(
      observations.sort((left, right) =>
        compareCodeUnits(left.identity, right.identity),
      ),
    );
  } catch {
    throw new TypeError(INVALID_RESULT);
  }
}
