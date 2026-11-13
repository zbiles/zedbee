import { compareCodeUnits } from "../core/compare.js";

const UNSAFE_CONFIGURATION_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function unsupportedConfiguration(): TypeError {
  return new TypeError(
    "Managed configuration must contain only JSON-compatible data.",
  );
}

function immutableJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (Number.isFinite(value)) return value;
      throw unsupportedConfiguration();
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      throw unsupportedConfiguration();
    case "object":
      break;
  }

  if (ancestors.has(value)) throw unsupportedConfiguration();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw unsupportedConfiguration();
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
        throw unsupportedConfiguration();
      }
      return Object.freeze(
        Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (
            descriptor === undefined ||
            descriptor.enumerable !== true ||
            !("value" in descriptor)
          ) {
            throw unsupportedConfiguration();
          }
          return immutableJsonValue(descriptor.value, ancestors);
        }),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw unsupportedConfiguration();
    }
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(value).sort((left, right) =>
      compareCodeUnits(String(left), String(right)),
    )) {
      if (typeof key !== "string" || UNSAFE_CONFIGURATION_KEYS.has(key)) {
        throw unsupportedConfiguration();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw unsupportedConfiguration();
      }
      entries.push([key, immutableJsonValue(descriptor.value, ancestors)]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
}

export function immutableConfigurationSnapshot<T>(value: T): Readonly<T> {
  return immutableJsonValue(value, new Set()) as Readonly<T>;
}
