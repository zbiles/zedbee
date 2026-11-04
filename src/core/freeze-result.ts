/** Deeply freezes acyclic plain result objects and arrays, not Maps or class instances. */
export function freezeResult<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freezeResult(nested);
    Object.freeze(value);
  }
  return value;
}
