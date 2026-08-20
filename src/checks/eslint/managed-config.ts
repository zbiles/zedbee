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

export type ReactCorrectnessConfigFactory = (
  reactVersion: string,
) => Linter.Config;

export interface ManagedConfigOptions {
  readonly mode: ManagedEslintMode;
  readonly managedIgnores: readonly string[];
  readonly reactVersion?: string;
  readonly reactCorrectnessConfigFactory?: ReactCorrectnessConfigFactory;
  readonly typedProject?: {
    readonly programs: readonly ts.Program[];
  };
}

function modePlugins(options: ManagedConfigOptions): Linter.Config | undefined {
  switch (options.mode) {
    case "lint":
      return {
        files: SOURCE_FILES,
        plugins: { "@typescript-eslint": tseslint.plugin },
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
  const plugins = modePlugins(options);
  if (plugins !== undefined) config.push(plugins);
  return config;
}
