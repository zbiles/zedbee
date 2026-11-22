import { copyStrictJson } from "./strict-json.js";

function unsupportedConfiguration(): TypeError {
  return new TypeError(
    "Managed configuration must contain only JSON-compatible data.",
  );
}

export function immutableConfigurationSnapshot<T>(value: T): Readonly<T> {
  return copyStrictJson(
    value,
    new Set(),
    unsupportedConfiguration,
    true,
  ) as Readonly<T>;
}
