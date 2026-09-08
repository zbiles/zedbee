import js from "@eslint/js";
import type { ESLint, Linter } from "eslint";
import type * as ts from "typescript";
import tseslint from "typescript-eslint";
import { managedTypescriptPlugin } from "./comment-directive.js";
import { reuseJavascriptParser, reuseTypescriptParser } from "./parse-store.js";
import type {
  FilePolicyResolver,
  SnapshotSide,
} from "../../config/file-policy.js";
import type { EslintRuleConfiguration } from "../../config/settings-definition.js";
import type { CheckId } from "../../config/schema.js";
import { compareCodeUnits } from "../../core/compare.js";
import { markUnresettableAnalyzerState } from "../runner/session.js";
import { readabilityComplexityRule } from "../complexity/readability-rule.js";
import {
  managedReactAccessibilityConfig,
  managedReactCorrectnessConfig,
} from "../react/config.js";
import {
  validateManagedRuleConfiguration,
  type RuleCheckId,
} from "./rule-settings.js";

const JAVASCRIPT_FILES = ["**/*.{js,jsx,mjs,cjs}"];
const TYPESCRIPT_FILES = ["**/*.{ts,tsx,mts,cts}"];
const SOURCE_FILES = ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];

export const readabilityComplexityPlugin: ESLint.Plugin = Object.freeze({
  rules: Object.freeze({
    "readability-complexity": readabilityComplexityRule,
  }),
});

export type ManagedEslintMode =
  "lint" | "complexity" | "react-correctness" | "react-accessibility";

export type ReactCorrectnessConfigFactory = (
  reactVersion: string,
) => Linter.Config;

export interface ManagedConfigOptions {
  readonly mode: ManagedEslintMode;
  readonly managedIgnores: readonly string[];
  readonly ruleOverrides?: Readonly<Record<string, EslintRuleConfiguration>>;
  readonly reactVersion?: string;
  readonly reactCorrectnessConfigFactory?: ReactCorrectnessConfigFactory;
  readonly typedProject?: {
    readonly programs: readonly ts.Program[];
  };
  readonly typeInformation?: "basic";
}

export interface FileRuleGroup {
  readonly fingerprint: string;
  readonly files: readonly string[];
  readonly rules: Readonly<Record<string, EslintRuleConfiguration>>;
}

function stableRuleValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableRuleValue(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      compareCodeUnits(left, right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableRuleValue(item)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Managed rule configuration is not serializable.");
  }
  return encoded;
}

export function groupFilesByRules(
  files: readonly string[],
  side: SnapshotSide,
  resolve: FilePolicyResolver,
  checkId: RuleCheckId,
): readonly FileRuleGroup[] {
  const groups = new Map<
    string,
    { files: string[]; rules: FileRuleGroup["rules"] }
  >();
  for (const file of [...files].sort(compareCodeUnits)) {
    const policy = resolve(checkId as CheckId, file, side);
    if (policy.severity === "off" || !("rules" in policy)) continue;
    const validatedRules = validateManagedRuleConfiguration(
      checkId,
      policy.rules,
    );
    const rules = Object.freeze(
      Object.fromEntries(
        Object.entries(validatedRules).sort(([left], [right]) =>
          compareCodeUnits(left, right),
        ),
      ),
    );
    const fingerprint = stableRuleValue(rules);
    const group = groups.get(fingerprint);
    if (group === undefined) {
      groups.set(fingerprint, { files: [file], rules });
    } else {
      group.files.push(file);
    }
  }
  return Object.freeze(
    [...groups.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([fingerprint, group]) =>
        Object.freeze({
          fingerprint,
          files: Object.freeze(group.files),
          rules: group.rules,
        }),
      ),
  );
}

function ruleCheckId(mode: ManagedEslintMode): RuleCheckId | undefined {
  switch (mode) {
    case "lint":
      return "lint";
    case "react-correctness":
      return "reactCorrectness";
    case "react-accessibility":
      return "reactAccessibility";
    case "complexity":
      return undefined;
  }
}

function modePlugins(options: ManagedConfigOptions): Linter.Config | undefined {
  switch (options.mode) {
    case "lint":
      return {
        files: SOURCE_FILES,
        plugins: { "@typescript-eslint": managedTypescriptPlugin },
      };
    case "react-correctness":
      if (options.reactVersion === undefined) {
        throw new TypeError(
          "Managed React correctness requires a React version.",
        );
      }
      return (
        options.reactCorrectnessConfigFactory ?? managedReactCorrectnessConfig
      )(options.reactVersion);
    case "react-accessibility":
      return managedReactAccessibilityConfig();
    case "complexity":
      return {
        files: SOURCE_FILES,
        plugins: {
          zedbee: readabilityComplexityPlugin,
        },
        rules: {
          complexity: ["error", { max: 0 }],
          "zedbee/readability-complexity": "error",
        },
      };
  }
}

export function managedConfig(
  options: ManagedConfigOptions,
): readonly Linter.Config[] {
  const config: Linter.Config[] = [
    { ignores: [...options.managedIgnores] },
    {
      files: JAVASCRIPT_FILES,
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        parser: reuseJavascriptParser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    },
    {
      files: TYPESCRIPT_FILES,
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        parser: reuseTypescriptParser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    },
  ];
  if (options.mode === "lint") {
    config.push({
      files: JAVASCRIPT_FILES,
      rules: { ...js.configs.recommended.rules },
    });
    if (options.typedProject !== undefined) {
      for (const preset of tseslint.configs.recommendedTypeChecked) {
        const presetConfig = preset as Linter.Config;
        const parserOptions = presetConfig.languageOptions?.parserOptions;
        config.push({
          ...presetConfig,
          files: TYPESCRIPT_FILES,
          languageOptions: {
            ...presetConfig.languageOptions,
            parser: reuseTypescriptParser,
            parserOptions: {
              ...(typeof parserOptions === "object" && parserOptions !== null
                ? parserOptions
                : {}),
              programs: [...options.typedProject.programs],
            },
          },
          ...(presetConfig.rules === undefined
            ? {}
            : { rules: { ...presetConfig.rules } }),
          ...(presetConfig.plugins === undefined
            ? {}
            : {
                plugins: {
                  ...presetConfig.plugins,
                  "@typescript-eslint": managedTypescriptPlugin,
                },
              }),
        });
      }
    } else if (options.typeInformation === "basic") {
      for (const preset of tseslint.configs.recommended) {
        const presetConfig = preset as Linter.Config;
        config.push({
          ...presetConfig,
          files: TYPESCRIPT_FILES,
          languageOptions: {
            ...presetConfig.languageOptions,
            parser: reuseTypescriptParser,
          },
          ...(presetConfig.rules === undefined
            ? {}
            : { rules: { ...presetConfig.rules } }),
          ...(presetConfig.plugins === undefined
            ? {}
            : {
                plugins: {
                  ...presetConfig.plugins,
                  "@typescript-eslint": managedTypescriptPlugin,
                },
              }),
        });
      }
    }
  }
  const plugins = modePlugins(options);
  if (plugins !== undefined) config.push(plugins);
  if (options.ruleOverrides !== undefined) {
    const checkId = ruleCheckId(options.mode);
    if (checkId === undefined) {
      throw new TypeError("Managed complexity does not accept rule overrides.");
    }
    let rules = validateManagedRuleConfiguration(
      checkId,
      options.ruleOverrides,
    );
    if (options.mode === "lint" && options.typeInformation === "basic") {
      rules = Object.freeze(
        Object.fromEntries(
          Object.entries(rules).filter(([ruleId]) => {
            if (!ruleId.startsWith("@typescript-eslint/")) return true;
            const name = ruleId.slice("@typescript-eslint/".length);
            const plugin = tseslint.plugin as unknown as {
              rules?: Record<string, unknown>;
            };
            const rule = plugin.rules?.[name] as
              | { meta?: { docs?: { requiresTypeChecking?: boolean } } }
              | undefined;
            return rule?.meta?.docs?.requiresTypeChecking !== true;
          }),
        ),
      );
    }
    if (Object.keys(rules).length > 0) {
      config.push({
        files: SOURCE_FILES,
        rules: rules as Linter.RulesRecord,
      });
    }
  }
  if (options.mode === "react-correctness") {
    const effective = Object.assign(
      {},
      ...config.map((entry) => entry.rules ?? {}),
    ) as Linter.RulesRecord;
    if (
      Object.entries(effective).some(([name, setting]) => {
        if (
          !name.startsWith("react-hooks/") ||
          [
            "react-hooks/rules-of-hooks",
            "react-hooks/exhaustive-deps",
          ].includes(name)
        )
          return false;
        const severity = Array.isArray(setting) ? setting[0] : setting;
        return severity !== "off" && severity !== 0;
      })
    )
      markUnresettableAnalyzerState();
  }
  return config;
}
