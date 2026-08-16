import type { SourceLocation } from "../../core/types.js";
import { normalizeSourceLocation } from "../../attribution/fingerprint.js";

export function structuralSecurityIdentity(
  rule: string,
  location: SourceLocation,
): string {
  const normalized = normalizeSourceLocation(location);
  return [
    rule,
    normalized.file,
    normalized.startLine,
    normalized.startColumn,
    normalized.endLine,
    normalized.endColumn,
  ].join(":");
}
