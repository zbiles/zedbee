import { createRequire } from "node:module";
import type { ESLint, Linter } from "eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";

const require = createRequire(import.meta.url);
const jsxA11yPlugin = require("eslint-plugin-jsx-a11y") as ESLint.Plugin & {
  readonly flatConfigs: { readonly recommended: Linter.Config };
};

const SOURCE_FILES = ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];

type ReactFlatConfigs = {
  readonly recommended: Linter.Config;
  readonly "jsx-runtime": Linter.Config;
};

type HooksFlatConfigs = {
  readonly recommended: Linter.Config;
};

export function managedReactCorrectnessConfig(): Linter.Config {
  const reactConfigs = reactPlugin.configs.flat as unknown as ReactFlatConfigs;
  const hooksConfigs = reactHooksPlugin.configs.flat as HooksFlatConfigs;
  return {
    files: SOURCE_FILES,
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin as unknown as ESLint.Plugin,
    },
    settings: { react: { version: "19.2" } },
    rules: {
      ...reactConfigs.recommended.rules,
      ...reactConfigs["jsx-runtime"].rules,
      ...hooksConfigs.recommended.rules,
    },
  };
}

export function managedReactAccessibilityConfig(): Linter.Config {
  return {
    files: SOURCE_FILES,
    plugins: { "jsx-a11y": jsxA11yPlugin as ESLint.Plugin },
    rules: { ...jsxA11yPlugin.flatConfigs.recommended.rules },
  };
}
