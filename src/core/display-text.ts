/** Maximum lengths for strings that can reach a terminal or machine report. */
export const DISPLAY_TEXT_LIMITS = Object.freeze({
  label: 256,
  prose: 4096,
} as const);

// C0/C1 controls, Unicode format controls (including bidi overrides), and
// JavaScript's explicit line/paragraph separators are never terminal-safe.
const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

export function canonicalDisplayText(
  value: unknown,
  field: string,
  maximumLength: number,
  options: Readonly<{ allowEmpty?: boolean }> = {},
): string {
  if (
    typeof value !== "string" ||
    (options.allowEmpty !== true && value.length === 0) ||
    value.length > maximumLength ||
    UNSAFE_DISPLAY_CHARACTER.test(value)
  ) {
    throw new TypeError(`Expected safe ${field} display text`);
  }
  return value;
}

export function displayLabel(value: unknown, field: string): string {
  return canonicalDisplayText(value, field, DISPLAY_TEXT_LIMITS.label);
}

export function displayProse(
  value: unknown,
  field: string,
  options: Readonly<{ allowEmpty?: boolean }> = {},
): string {
  return canonicalDisplayText(value, field, DISPLAY_TEXT_LIMITS.prose, options);
}
