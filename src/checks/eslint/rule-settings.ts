import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ESLint, Rule } from "eslint";
import { builtinRules } from "eslint/use-at-your-own-risk";
import type { EslintRuleConfiguration } from "../../config/settings-definition.js";
import { freezeRuleSettings } from "./freeze-rule-settings.js";
export { freezeRuleSettings } from "./freeze-rule-settings.js";

const require = createRequire(import.meta.url);
const eslintRoot = dirname(require.resolve("eslint/package.json"));
const jsLanguage = require(
  join(eslintRoot, "lib/languages/js/index.js"),
) as unknown;
const { Config } = require(join(eslintRoot, "lib/config/config.js")) as {
  readonly Config: new (config: unknown) => unknown;
};

export type RuleCheckId = "lint" | "reactCorrectness" | "reactAccessibility";
export type LintRuleSettings = Readonly<
  Record<string, EslintRuleConfiguration>
>;
export type ReactCorrectnessRuleSettings = Readonly<
  Record<string, EslintRuleConfiguration>
>;
export type ReactAccessibilityRuleSettings = Readonly<
  Record<string, EslintRuleConfiguration>
>;

type RuleInventory = ReadonlyMap<string, Rule.RuleModule>;

type ManagedRulePlugin = ESLint.Plugin & {
  readonly rules?: Record<string, Rule.RuleModule>;
};

export class ManagedRuleConfigurationError extends TypeError {
  readonly ruleId?: string;

  constructor(message: string, ruleId?: string) {
    super(message);
    this.name = "ManagedRuleConfigurationError";
    if (ruleId !== undefined) this.ruleId = ruleId;
  }
}

function isRuleModule(value: unknown): value is Rule.RuleModule {
  return typeof value === "object" && value !== null && "create" in value;
}

function prefixedRules(
  prefix: string,
  rules: Readonly<Record<string, Rule.RuleModule>> | undefined,
): [string, Rule.RuleModule][] {
  if (rules === undefined) return [];
  return Object.entries(rules).map(([ruleName, rule]) => [
    `${prefix}/${ruleName}`,
    rule,
  ]);
}

function buildInventory(
  checkId: RuleCheckId,
  entries: readonly [string, Rule.RuleModule][],
): Map<string, Rule.RuleModule> {
  const inventory = new Map<string, Rule.RuleModule>();
  for (const [ruleId, rule] of entries) {
    if (!isRuleModule(rule)) {
      throw new ManagedRuleConfigurationError(
        `Managed ${checkId} rule "${ruleId}" cannot be validated.`,
        ruleId,
      );
    }
    if (inventory.has(ruleId)) {
      throw new ManagedRuleConfigurationError(
        `Managed rule "${ruleId}" has duplicate ${checkId} ownership.`,
        ruleId,
      );
    }
    inventory.set(ruleId, rule);
  }
  return inventory;
}

class ReadonlyRuleInventory implements RuleInventory {
  readonly #inventory: RuleInventory;

  constructor(inventory: RuleInventory) {
    this.#inventory = inventory;
  }

  get size(): number {
    return this.#inventory.size;
  }

  [Symbol.iterator](): MapIterator<[string, Rule.RuleModule]> {
    return this.#inventory[Symbol.iterator]();
  }

  entries(): MapIterator<[string, Rule.RuleModule]> {
    return this.#inventory.entries();
  }

  forEach(
    callbackfn: (
      value: Rule.RuleModule,
      key: string,
      map: ReadonlyMap<string, Rule.RuleModule>,
    ) => void,
    thisArg?: unknown,
  ): void {
    this.#inventory.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }

  get(key: string): Rule.RuleModule | undefined {
    return this.#inventory.get(key);
  }

  has(key: string): boolean {
    return this.#inventory.has(key);
  }

  keys(): MapIterator<string> {
    return this.#inventory.keys();
  }

  values(): MapIterator<Rule.RuleModule> {
    return this.#inventory.values();
  }
}

interface ManagedRuleResources {
  readonly inventory: RuleInventory;
  readonly plugins: Readonly<Record<string, unknown>>;
}

// Only package-owned rule metadata is retained. No repository inputs or results
// enter this cache. Session release clears input-bearing parser state separately;
// trusted package rule modules can remain loaded in a reusable worker.
const resourcesByCheckId = new Map<RuleCheckId, ManagedRuleResources>();

function managedRuleResources(checkId: RuleCheckId): ManagedRuleResources {
  const existing = resourcesByCheckId.get(checkId);
  if (existing !== undefined) return existing;
  const coreRules = Object.fromEntries(builtinRules) as Record<
    string,
    Rule.RuleModule
  >;
  const plugins: Record<string, ManagedRulePlugin> = {};
  switch (checkId) {
    case "lint":
      plugins["@typescript-eslint"] = (
        require("typescript-eslint") as typeof import("typescript-eslint")
      ).plugin as ManagedRulePlugin;
      break;
    case "reactCorrectness":
      plugins.react = require("eslint-plugin-react") as ManagedRulePlugin;
      plugins["react-hooks"] =
        require("eslint-plugin-react-hooks") as ManagedRulePlugin;
      break;
    case "reactAccessibility":
      plugins["jsx-a11y"] =
        require("eslint-plugin-jsx-a11y") as ManagedRulePlugin;
      break;
  }
  const inventory = buildInventory(checkId, [
    ...(checkId === "lint" ? Object.entries(coreRules) : []),
    ...Object.entries(plugins).flatMap(([prefix, plugin]) =>
      prefixedRules(prefix, plugin.rules),
    ),
  ]);
  for (const [owner, resources] of resourcesByCheckId) {
    for (const ruleId of inventory.keys()) {
      if (resources.inventory.has(ruleId)) {
        throw new ManagedRuleConfigurationError(
          `Managed rule "${ruleId}" is owned by both ${owner} and ${checkId}.`,
          ruleId,
        );
      }
    }
  }
  const resources = Object.freeze({
    inventory: Object.freeze(new ReadonlyRuleInventory(inventory)),
    plugins: Object.freeze({
      "@": Object.freeze({
        languages: Object.freeze({ js: jsLanguage }),
        rules: coreRules,
      }),
      ...plugins,
    }),
  });
  resourcesByCheckId.set(checkId, resources);
  return resources;
}

const unsafeJsonKeys = new Set(["__proto__", "prototype", "constructor"]);

function jsonCompatibilityError(
  ruleId?: string,
): ManagedRuleConfigurationError {
  return new ManagedRuleConfigurationError(
    "Managed rule options must contain only JSON-compatible data.",
    ruleId,
  );
}

function cloneJsonCompatibleValue(
  value: unknown,
  ruleId: string,
  ancestors: Set<object>,
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (Number.isFinite(value)) return value;
      throw jsonCompatibilityError(ruleId);
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      throw jsonCompatibilityError(ruleId);
    case "object":
      break;
  }

  if (ancestors.has(value)) throw jsonCompatibilityError(ruleId);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw jsonCompatibilityError(ruleId);
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
        throw jsonCompatibilityError(ruleId);
      }
      const clone: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        ) {
          throw jsonCompatibilityError(ruleId);
        }
        clone.push(
          cloneJsonCompatibleValue(descriptor.value, ruleId, ancestors),
        );
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw jsonCompatibilityError(ruleId);
    }
    const clone: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || unsafeJsonKeys.has(key)) {
        throw jsonCompatibilityError(ruleId);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw jsonCompatibilityError(ruleId);
      }
      clone[key] = cloneJsonCompatibleValue(
        descriptor.value,
        ruleId,
        ancestors,
      );
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function cloneJsonCompatibleRules(
  input: Readonly<Record<string, EslintRuleConfiguration>>,
): Record<string, EslintRuleConfiguration> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw jsonCompatibilityError();
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw jsonCompatibilityError();
  }
  const clone: Record<string, EslintRuleConfiguration> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || unsafeJsonKeys.has(key)) {
      throw jsonCompatibilityError(typeof key === "string" ? key : undefined);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw jsonCompatibilityError(key);
    }
    clone[key] = cloneJsonCompatibleValue(
      descriptor.value,
      key,
      new Set([input]),
    ) as EslintRuleConfiguration;
  }
  return clone;
}

function clonePlainValidationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => clonePlainValidationValue(item));
  }

  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        clonePlainValidationValue(item),
      ]),
    );
  }

  return value;
}

function validationRuleConfiguration(
  configuration: EslintRuleConfiguration,
): EslintRuleConfiguration {
  const clone = clonePlainValidationValue(configuration);
  if (!Array.isArray(clone)) return 2;
  return [2, ...clone.slice(1)] as EslintRuleConfiguration;
}

function isValidSeverity(value: unknown): boolean {
  return (
    value === "off" ||
    value === "warn" ||
    value === "error" ||
    value === 0 ||
    value === 1 ||
    value === 2
  );
}

function assertValidSeverity(
  checkId: RuleCheckId,
  rules: Readonly<Record<string, EslintRuleConfiguration>>,
): void {
  for (const [ruleId, configuration] of Object.entries(rules)) {
    const severity = Array.isArray(configuration)
      ? configuration[0]
      : configuration;
    if (!isValidSeverity(severity)) {
      throw new ManagedRuleConfigurationError(
        `invalid rule configuration for managed ${checkId} rules.`,
        ruleId,
      );
    }
  }
}

function validationRuleSettings(
  rules: Readonly<Record<string, EslintRuleConfiguration>>,
): Record<string, EslintRuleConfiguration> {
  return Object.fromEntries(
    Object.entries(rules).map(([ruleId, configuration]) => [
      ruleId,
      validationRuleConfiguration(configuration),
    ]),
  );
}

function validateWithPinnedEslintConfig(
  checkId: RuleCheckId,
  rules: Readonly<Record<string, EslintRuleConfiguration>>,
): void {
  new Config({
    language: "@/js",
    plugins: managedRuleResources(checkId).plugins,
    rules: validationRuleSettings(rules),
  });
}

function ruleConfigurationSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Expected severity/u.test(message)) return "invalid rule configuration";
  return "invalid rule options";
}

function validateRuleId(checkId: RuleCheckId, ruleId: string): void {
  if (/[\p{Cc}\p{Cf}]/u.test(ruleId)) {
    throw new ManagedRuleConfigurationError(
      `Managed rule "${ruleId}" contains a control character.`,
      ruleId,
    );
  }

  if (managedRuleInventory(checkId).has(ruleId)) return;

  const owner = (
    ["lint", "reactCorrectness", "reactAccessibility"] as const
  ).find(
    (candidate) =>
      candidate !== checkId && managedRuleInventory(candidate).has(ruleId),
  );
  if (owner !== undefined) {
    throw new ManagedRuleConfigurationError(
      `Managed rule "${ruleId}" belongs to ${owner}, not ${checkId}.`,
      ruleId,
    );
  }

  throw new ManagedRuleConfigurationError(
    `Managed rule "${ruleId}" is an unsupported rule.`,
    ruleId,
  );
}

function validateRuleOptions(
  checkId: RuleCheckId,
  rules: Readonly<Record<string, EslintRuleConfiguration>>,
): void {
  try {
    assertValidSeverity(checkId, rules);
    validateWithPinnedEslintConfig(checkId, rules);
  } catch (error) {
    if (error instanceof ManagedRuleConfigurationError) throw error;
    const ruleId =
      error instanceof Error
        ? Object.keys(rules).find((candidate) =>
            error.message.includes(candidate),
          )
        : undefined;
    throw new ManagedRuleConfigurationError(
      `${ruleConfigurationSummary(error)} for managed ${checkId} rules.`,
      ruleId,
    );
  }
}

export function managedRuleInventory(checkId: RuleCheckId): RuleInventory {
  return managedRuleResources(checkId).inventory;
}

export function validateManagedRuleConfiguration(
  checkId: RuleCheckId,
  input: Readonly<Record<string, EslintRuleConfiguration>>,
): Readonly<Record<string, EslintRuleConfiguration>> {
  const detached = cloneJsonCompatibleRules(input);
  for (const ruleId of Object.keys(detached)) {
    validateRuleId(checkId, ruleId);
  }
  validateRuleOptions(checkId, detached);
  return freezeRuleSettings(detached);
}
