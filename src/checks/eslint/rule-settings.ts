import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ESLint, Rule } from "eslint";
import { builtinRules } from "eslint/use-at-your-own-risk";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import type { EslintRuleConfiguration } from "../../config/settings-definition.js";

const require = createRequire(import.meta.url);
const eslintRoot = dirname(require.resolve("eslint/package.json"));
const jsLanguage = require(
  join(eslintRoot, "lib/languages/js/index.js"),
) as unknown;
const { Config } = require(join(eslintRoot, "lib/config/config.js")) as {
  readonly Config: new (config: unknown) => unknown;
};
const jsxA11yPlugin = require("eslint-plugin-jsx-a11y") as ESLint.Plugin;

export type RuleCheckId = "lint" | "reactCorrectness" | "reactAccessibility";
export type LintRuleSettings = Readonly<Record<string, EslintRuleConfiguration>>;
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

type RuleOwner = {
  readonly checkId: RuleCheckId;
  readonly label: string;
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
): RuleInventory {
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
  return Object.freeze(inventory);
}

const coreRules = Object.fromEntries(builtinRules) as Record<
  string,
  Rule.RuleModule
>;

const lintInventory = buildInventory("lint", [
  ...Object.entries(coreRules),
  ...prefixedRules(
    "@typescript-eslint",
    (tseslint.plugin as ManagedRulePlugin).rules,
  ),
]);
const reactCorrectnessInventory = buildInventory("reactCorrectness", [
  ...prefixedRules("react", (reactPlugin as ManagedRulePlugin).rules),
  ...prefixedRules(
    "react-hooks",
    (reactHooksPlugin as unknown as ManagedRulePlugin).rules,
  ),
]);
const reactAccessibilityInventory = buildInventory("reactAccessibility", [
  ...prefixedRules("jsx-a11y", jsxA11yPlugin.rules),
]);

const inventoryByCheckId = Object.freeze({
  lint: lintInventory,
  reactCorrectness: reactCorrectnessInventory,
  reactAccessibility: reactAccessibilityInventory,
}) satisfies Readonly<Record<RuleCheckId, RuleInventory>>;

const ownerByRuleId = new Map<string, RuleOwner>();
for (const [checkId, inventory] of Object.entries(inventoryByCheckId) as [
  RuleCheckId,
  RuleInventory,
][]) {
  for (const ruleId of inventory.keys()) {
    const existing = ownerByRuleId.get(ruleId);
    if (existing !== undefined) {
      throw new ManagedRuleConfigurationError(
        `Managed rule "${ruleId}" is owned by both ${existing.checkId} and ${checkId}.`,
        ruleId,
      );
    }
    ownerByRuleId.set(ruleId, { checkId, label: checkId });
  }
}

const languagePlugin = Object.freeze({
  languages: Object.freeze({ js: jsLanguage }),
  rules: coreRules,
});

const validationPlugins = Object.freeze({
  lint: Object.freeze({
    "@": languagePlugin,
    "@typescript-eslint": tseslint.plugin,
  }),
  reactCorrectness: Object.freeze({
    "@": languagePlugin,
    react: reactPlugin,
    "react-hooks": reactHooksPlugin,
  }),
  reactAccessibility: Object.freeze({
    "@": languagePlugin,
    "jsx-a11y": jsxA11yPlugin,
  }),
}) satisfies Readonly<Record<RuleCheckId, Readonly<Record<string, unknown>>>>;

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

  const owner = ownerByRuleId.get(ruleId);
  if (owner !== undefined) {
    throw new ManagedRuleConfigurationError(
      `Managed rule "${ruleId}" belongs to ${owner.label}, not ${checkId}.`,
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
    new Config({
      language: "@/js",
      plugins: validationPlugins[checkId],
      rules: { ...rules },
    });
  } catch (error) {
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

function freezeDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeDeep(item))) as T;
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return Object.freeze(value);
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, freezeDeep(item)]),
      ),
    ) as T;
  }
  return value;
}

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

export function managedRuleInventory(checkId: RuleCheckId): RuleInventory {
  return inventoryByCheckId[checkId];
}

export function validateManagedRuleConfiguration(
  checkId: RuleCheckId,
  input: Readonly<Record<string, EslintRuleConfiguration>>,
): Readonly<Record<string, EslintRuleConfiguration>> {
  for (const ruleId of Object.keys(input)) {
    validateRuleId(checkId, ruleId);
  }
  validateRuleOptions(checkId, input);
  return freezeRuleSettings(input);
}
