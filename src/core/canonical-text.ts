/** Non-empty, trimmed text without C0 control characters or DEL. */
export function isCanonicalText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function canonicalText(value: unknown, field: string): string {
  if (!isCanonicalText(value)) {
    throw new TypeError(`Expected canonical ${field}`);
  }
  return value;
}
