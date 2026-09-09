import type { EslintRuleConfiguration } from "../../config/settings-definition.js";

function freezeDeep<T>(value: T): T {
  if (Array.isArray(value))
    return Object.freeze(value.map((item) => freezeDeep(item))) as T;
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      return Object.freeze(value);
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, freezeDeep(item)]),
      ),
    ) as T;
  }
  return value;
}

/** Pure detachment only; rule inventory/options validation remains in rule-settings. */
export function freezeRuleSettings(
  rules: Readonly<Record<string, EslintRuleConfiguration>>,
): Readonly<Record<string, EslintRuleConfiguration>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(rules).map(([ruleId, configuration]) => [
        ruleId,
        freezeDeep(configuration),
      ]),
    ),
  ) as Readonly<Record<string, EslintRuleConfiguration>>;
}
