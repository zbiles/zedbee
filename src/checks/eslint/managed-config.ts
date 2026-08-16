import js from "@eslint/js";
import type { ESLint, Linter } from "eslint";
import type * as ts from "typescript";
import tseslint from "typescript-eslint";
import { readabilityComplexityRule } from "../complexity/readability-rule.js";
import {
  managedReactAccessibilityConfig,
  managedReactCorrectnessConfig,
} from "../react/config.js";

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

export interface ManagedConfigOptions {
  readonly mode: ManagedEslintMode;
  readonly managedIgnores: readonly string[];
  readonly typedProject?: {
    readonly programs: readonly ts.Program[];
  };
}

function modePlugins(mode: ManagedEslintMode): Linter.Config | undefined {
  switch (mode) {
    case "lint":
      return {
        files: SOURCE_FILES,
        plugins: { "@typescript-eslint": tseslint.plugin },
      };
    case "react-correctness":
      return managedReactCorrectnessConfig();
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
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    },
    {
      files: TYPESCRIPT_FILES,
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        parser: tseslint.parser,
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
            : { plugins: { ...presetConfig.plugins } }),
        });
      }
    }
  }
  const plugins = modePlugins(options.mode);
  if (plugins !== undefined) config.push(plugins);
  return config;
}
