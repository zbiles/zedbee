export type DiagnosticRedactionReason =
  | "sensitive-value"
  | "context-unavailable"
  | "unsupported-template"
  | "source-free-policy";

const DIAGNOSTIC_REDACTION_REASONS = new Set<string>([
  "sensitive-value",
  "context-unavailable",
  "unsupported-template",
  "source-free-policy",
]);

export function isDiagnosticRedaction(value: unknown): value is {
  readonly redacted: true;
  readonly reasons: readonly DiagnosticRedactionReason[];
} {
  if (typeof value !== "object" || value === null) return false;
  const { redacted, reasons } = value as {
    readonly redacted?: unknown;
    readonly reasons?: unknown;
  };
  if (redacted !== true || !Array.isArray(reasons) || reasons.length > 4)
    return false;
  return reasons.every((reason) =>
    DIAGNOSTIC_REDACTION_REASONS.has(reason as string),
  );
}
