import { createRequire } from "node:module";
import js from "@eslint/js";
import type { ESLint } from "eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { describe, expect, test } from "vitest";
import {
  managedConfig,
  readabilityComplexityPlugin,
  type ManagedEslintMode,
} from "../../../src/checks/eslint/managed-config.js";

const require = createRequire(import.meta.url);
const jsxA11yPlugin = require("eslint-plugin-jsx-a11y") as ESLint.Plugin;

const modes: readonly ManagedEslintMode[] = [
  "lint",
  "complexity",
  "react-correctness",
  "react-accessibility",
];

describe("managedConfig", () => {
  test("uses only Zedbee-owned parser and plugin objects", () => {
    const allowedPlugins = new Set<unknown>([
      tseslint.plugin,
      reactPlugin,
      reactHooksPlugin,
      jsxA11yPlugin,
      readabilityComplexityPlugin,
    ]);
    const allowedParsers = new Set<unknown>([tseslint.parser]);

    for (const mode of modes) {
      const config = managedConfig({ mode, managedIgnores: [] });
      for (const entry of config) {
        for (const plugin of Object.values(entry.plugins ?? {})) {
          expect(typeof plugin).not.toBe("string");
          expect(allowedPlugins.has(plugin)).toBe(true);
        }
        const parser = entry.languageOptions?.parser;
        if (parser !== undefined) {
          expect(typeof parser).not.toBe("string");
          expect(allowedParsers.has(parser)).toBe(true);
        }
      }
    }

    expect(js.configs.recommended.rules).toBeDefined();
  });

  test("keeps managed ignores in their own flat-config entry", () => {
    const config = managedConfig({
      mode: "lint",
      managedIgnores: ["coverage/**", "vendor/**"],
    });

    expect(config[0]).toEqual({ ignores: ["coverage/**", "vendor/**"] });
    expect(config.slice(1).every((entry) => entry.ignores === undefined)).toBe(
      true,
    );
  });
});
