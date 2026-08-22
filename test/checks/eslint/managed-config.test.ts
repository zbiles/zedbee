import { createRequire } from "node:module";
import js from "@eslint/js";
import type { ESLint } from "eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { describe, expect, test } from "vitest";
import {
  groupFilesByRules,
  managedConfig,
  readabilityComplexityPlugin,
  type ManagedEslintMode,
} from "../../../src/checks/eslint/managed-config.js";
import type { FilePolicyResolver } from "../../../src/config/file-policy.js";
import { managedReactCorrectnessConfig } from "../../../src/checks/react/config.js";

const require = createRequire(import.meta.url);
const jsxA11yPlugin = require("eslint-plugin-jsx-a11y") as ESLint.Plugin;

const modes: readonly ManagedEslintMode[] = [
  "lint",
  "complexity",
  "react-correctness",
  "react-accessibility",
];

describe("managedConfig", () => {
  test("calibrates React correctness settings to the supplied version", () => {
    expect(managedReactCorrectnessConfig("18.3.1").settings).toEqual({
      react: { version: "18.3.1" },
    });
    expect(managedReactCorrectnessConfig("19.2.0").settings).toEqual({
      react: { version: "19.2.0" },
    });
  });

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
      const config = managedConfig({
        mode,
        managedIgnores: [],
        ...(mode === "react-correctness" ? { reactVersion: "19.2.0" } : {}),
      });
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

  test("requires a React version only for correctness mode", () => {
    expect(() =>
      managedConfig({ mode: "react-correctness", managedIgnores: [] }),
    ).toThrow(/React version/u);

    for (const mode of ["lint", "complexity", "react-accessibility"] as const) {
      expect(() => managedConfig({ mode, managedIgnores: [] })).not.toThrow();
    }
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

  test("appends detached validated rule overrides after managed presets", () => {
    const input = {
      "no-console": ["warn", { allow: ["warn"] }],
    } as const;
    const config = managedConfig({
      mode: "lint",
      managedIgnores: [],
      ruleOverrides: input,
    });
    const override = config.at(-1);

    expect(override).toEqual({
      files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
      rules: { "no-console": ["warn", { allow: ["warn"] }] },
    });
    expect(override?.rules).not.toBe(input);
    expect(Object.isFrozen(override?.rules)).toBe(true);
    expect(Object.isFrozen(override?.rules?.["no-console"])).toBe(true);
    expect(
      Object.isFrozen(
        (override?.rules?.["no-console"] as readonly unknown[])[1],
      ),
    ).toBe(true);
  });

  test("revalidates rule ownership at the managed engine config boundary", () => {
    expect(() =>
      managedConfig({
        mode: "lint",
        managedIgnores: [],
        ruleOverrides: { "react/jsx-key": "off" },
      }),
    ).toThrow(/belongs to reactCorrectness/u);
    expect(() =>
      managedConfig({
        mode: "react-accessibility",
        managedIgnores: [],
        ruleOverrides: { "company/private-rule": "error" },
      }),
    ).toThrow(/unsupported rule/u);
  });

  test("groups identical effective rules deterministically and skips off files", () => {
    const resolve = ((_checkId: string, file: string, _side: string) => ({
      severity: file === "generated/off.js" ? "off" : "error",
      when: "relevant",
      rules:
        file === "src/z.js"
          ? { "no-debugger": "error", "no-console": "warn" }
          : { "no-console": "warn", "no-debugger": "error" },
    })) as FilePolicyResolver;

    expect(
      groupFilesByRules(
        ["src/z.js", "generated/off.js", "src/a.js"],
        "target",
        resolve,
        "lint",
      ),
    ).toEqual([
      {
        fingerprint: '{"no-console":"warn","no-debugger":"error"}',
        files: ["src/a.js", "src/z.js"],
        rules: { "no-console": "warn", "no-debugger": "error" },
      },
    ]);
  });
});
