const UNSAFE_SOURCE_LINE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Produces stable, terminal-safe source text without collapsing indentation. */
export function sanitizeSourceLine(value: string): string {
  return value
    .replaceAll("\t", "  ")
    .replaceAll(UNSAFE_SOURCE_LINE_CHARACTER, "�");
}
