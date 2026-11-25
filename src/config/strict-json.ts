import { compareCodeUnits } from "../core/compare.js";

export function isUnsafeJsonKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

export function copyStrictJson(
  value: unknown,
  ancestors: Set<object>,
  invalid: () => Error,
  immutable: boolean,
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (Number.isFinite(value)) return value;
      throw invalid();
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      throw invalid();
    case "object":
      break;
  }

  if (ancestors.has(value)) throw invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw invalid();
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        keys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" &&
              (!/^(?:0|[1-9][0-9]*)$/u.test(key) ||
                Number(key) >= value.length)),
        )
      ) {
        throw invalid();
      }
      const array = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        ) {
          throw invalid();
        }
        return copyStrictJson(descriptor.value, ancestors, invalid, immutable);
      });
      return immutable ? Object.freeze(array) : array;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid();
    }
    const entries: [string, unknown][] = [];
    const keys = Reflect.ownKeys(value);
    if (immutable)
      keys.sort((left, right) => compareCodeUnits(String(left), String(right)));
    for (const key of keys) {
      if (typeof key !== "string" || isUnsafeJsonKey(key)) {
        throw invalid();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw invalid();
      }
      entries.push([
        key,
        copyStrictJson(descriptor.value, ancestors, invalid, immutable),
      ]);
    }
    const object = Object.fromEntries(entries);
    return immutable ? Object.freeze(object) : object;
  } finally {
    ancestors.delete(value);
  }
}
