import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";
import { managedRuleInventory } from "./rule-settings.js";

const ERROR_TYPES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
] as const;
export interface EslintFailureDetails {
  readonly type?: (typeof ERROR_TYPES)[number];
  readonly ruleId?: string;
  readonly reason?: "rule-execution-incompatible-types";
}

/** No exception prose, source, paths or stack frames belong in this contract. */
export function sanitizeEslintFailure(
  value: EslintFailureDetails,
): EslintFailureDetails {
  if (
    !value ||
    typeof value !== "object" ||
    (value.type !== undefined && !ERROR_TYPES.includes(value.type)) ||
    (value.ruleId !== undefined &&
      (typeof value.ruleId !== "string" ||
        value.ruleId.length > 200 ||
        !managedRuleInventory("lint").has(value.ruleId))) ||
    (value.reason !== undefined &&
      (value.reason !== "rule-execution-incompatible-types" ||
        value.type !== "TypeError" ||
        value.ruleId !== "@typescript-eslint/no-misused-promises"))
  )
    throw new TypeError("Invalid ESLint failure diagnostic");
  return Object.freeze({
    ...(value.type === undefined ? {} : { type: value.type }),
    ...(value.ruleId === undefined ? {} : { ruleId: value.ruleId }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  });
}

function ownString(error: Error, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor !== undefined &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function stackSignature(error: Error): string {
  // V8 exposes stack through a lazy accessor. Read it only for recognition;
  // never retain it or allow a throwing accessor to replace the lint failure.
  try {
    return typeof error.stack === "string" ? error.stack.slice(0, 16_384) : "";
  } catch {
    return "";
  }
}

export function eslintFailureDetails(error: unknown): EslintFailureDetails {
  if (!(error instanceof Error)) return Object.freeze({});
  const type =
    error instanceof TypeError
      ? "TypeError"
      : error instanceof RangeError
        ? "RangeError"
        : error instanceof SyntaxError
          ? "SyntaxError"
          : error instanceof ReferenceError
            ? "ReferenceError"
            : "Error";
  const candidate = ownString(error, "ruleId");
  const ruleId =
    candidate !== undefined &&
    candidate.length <= 200 &&
    managedRuleInventory("lint").has(candidate)
      ? candidate
      : undefined;
  // Recognize only the reproduced rule failure. The signature does not prove
  // which dependency version or source construct caused the incompatible type.
  const recognized =
    type === "TypeError" &&
    ruleId === "@typescript-eslint/no-misused-promises" &&
    ownString(error, "message")?.split("\n", 1)[0] ===
      "Cannot read properties of undefined (reading 'some')" &&
    /\bat hasWellKnownSymbolWithVoidReturn \([^\n]*[/\\]@typescript-eslint[/\\]eslint-plugin[/\\]dist[/\\]rules[/\\]no-misused-promises\.js:\d+:\d+\)/u.test(
      stackSignature(error),
    );
  return sanitizeEslintFailure({
    type,
    ...(ruleId === undefined ? {} : { ruleId }),
    ...(recognized
      ? { reason: "rule-execution-incompatible-types" as const }
      : {}),
  });
}

/** Path comes from the inspector-owned lintText call, never the exception. */
export class ManagedEslintFailure extends Error {
  readonly path: string;
  readonly details: EslintFailureDetails;
  constructor(path: string, error: unknown) {
    super("Managed ESLint failed while analyzing a requested file.");
    this.name = "ManagedEslintFailure";
    this.path = normalizeRepositoryRelativePath(path);
    this.details = eslintFailureDetails(error);
    Object.freeze(this);
  }
}
