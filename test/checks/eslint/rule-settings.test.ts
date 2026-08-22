import { describe, expect, it } from "vitest";
import {
  managedRuleInventory,
  validateManagedRuleConfiguration,
} from "../../../src/checks/eslint/rule-settings.js";

describe("managed lint rule settings", () => {
  it("accepts bounded core and TypeScript ESLint rule overrides", () => {
    expect(() =>
      validateManagedRuleConfiguration("lint", {
        "no-console": "warn",
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_" },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects rules owned by another managed check", () => {
    expect(() =>
      validateManagedRuleConfiguration("lint", {
        "jsx-a11y/no-autofocus": "off",
      }),
    ).toThrow(/reactAccessibility/u);
  });

  it("rejects unsupported private rules", () => {
    expect(() =>
      validateManagedRuleConfiguration("lint", {
        "company/private-rule": "error",
      }),
    ).toThrow(/unsupported rule/u);
  });

  it("accepts ESLint severity forms and full rule option arrays", () => {
    expect(() =>
      validateManagedRuleConfiguration("lint", {
        "no-console": 1,
        "no-alert": ["warn"],
        "no-restricted-syntax": [
          2,
          {
            selector: "CallExpression[callee.name='eval']",
            message: "Avoid eval in managed code.",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects malformed severity arrays before scanning", () => {
    const malformedRules = {
      "no-console": ["loud"],
    } as unknown as Parameters<typeof validateManagedRuleConfiguration>[1];

    expect(() =>
      validateManagedRuleConfiguration("lint", malformedRules),
    ).toThrow(/invalid rule configuration/u);
  });

  it("rejects invalid options using bundled rule schemas", () => {
    expect(() =>
      validateManagedRuleConfiguration("lint", {
        "no-restricted-syntax": [
          "error",
          {
            selector: 42,
            message: "selector must be a string",
          },
        ],
      }),
    ).toThrow(/invalid rule options/u);
  });

  it("rejects invalid rule options even when the requested severity is off", () => {
    expect(() =>
      validateManagedRuleConfiguration("lint", {
        "no-restricted-syntax": [
          "off",
          {
            selector: 42,
            message: "selector must be a string",
          },
        ],
      }),
    ).toThrow(/invalid rule options/u);
  });

  it("does not mutate caller-owned rule arrays or option objects during private validation", () => {
    const input = {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "CallExpression[callee.name='eval']",
          message: "Avoid eval in managed code.",
        },
      ],
    } as const;
    const expected = {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "CallExpression[callee.name='eval']",
          message: "Avoid eval in managed code.",
        },
      ],
    };

    const resolved = validateManagedRuleConfiguration("lint", input);

    expect(input).toEqual(expected);
    expect(resolved).toEqual(expected);
    const resolvedRule = resolved["no-restricted-syntax"];
    expect(Array.isArray(resolvedRule)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolvedRule)).toBe(true);
    expect(
      Array.isArray(resolvedRule) && Object.isFrozen(resolvedRule[1]),
    ).toBe(true);
  });

  it("accepts deeply frozen valid rule arrays", () => {
    const frozenRule = Object.freeze([
      "error",
      Object.freeze({
        selector: "CallExpression[callee.name='eval']",
        message: "Avoid eval in managed code.",
      }),
    ]) as unknown as Parameters<
      typeof validateManagedRuleConfiguration
    >[1][string];

    expect(() =>
      validateManagedRuleConfiguration("lint", {
        "no-restricted-syntax": frozenRule,
      }),
    ).not.toThrow();
  });

  it("rejects runtime-only rule option values before ESLint validation", () => {
    class RuntimeOption {
      readonly allow = ["warn"];
    }
    const cyclic: Record<string, unknown> = { allow: ["warn"] };
    cyclic.self = cyclic;
    const accessor = { marker: true } as Record<string, unknown>;
    Object.defineProperty(accessor, "allow", {
      enumerable: true,
      get: () => ["warn"],
    });
    const symbolKey = { allow: ["warn"] } as Record<string | symbol, unknown>;
    symbolKey[Symbol("hidden")] = "runtime-only";
    const hiddenKey = { allow: ["warn"] } as Record<string, unknown>;
    Object.defineProperty(hiddenKey, "hidden", {
      enumerable: false,
      value: "runtime-only",
    });

    const cases: readonly [string, unknown][] = [
      ["undefined", undefined],
      ["bigint", 1n],
      ["symbol", Symbol("option")],
      ["function", () => undefined],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["class instance", new RuntimeOption()],
      ["Date", new Date("2026-08-21T00:00:00.000Z")],
      ["RegExp", /warn/u],
      ["Map", new Map([["allow", ["warn"]]])],
      ["Set", new Set(["warn"])],
      ["accessor", accessor],
      ["symbol key", symbolKey],
      ["non-enumerable key", hiddenKey],
      ["cycle", cyclic],
    ];

    for (const [label, option] of cases) {
      const rules = {
        "no-console": ["warn", option],
      } as unknown as Parameters<typeof validateManagedRuleConfiguration>[1];
      expect(
        () => validateManagedRuleConfiguration("lint", rules),
        label,
      ).toThrow(/JSON-compatible/u);
    }
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects the prototype-pollution option key %s",
    (unsafeKey) => {
      const option = { allow: ["warn"] } as Record<string, unknown>;
      Object.defineProperty(option, unsafeKey, {
        enumerable: true,
        value: "unsafe",
      });
      const rules = {
        "no-console": ["warn", option],
      } as unknown as Parameters<typeof validateManagedRuleConfiguration>[1];

      expect(() => validateManagedRuleConfiguration("lint", rules)).toThrow(
        /JSON-compatible/u,
      );
    },
  );

  it("rejects symbol keys on the rule map itself", () => {
    const rules = { "no-console": "warn" } as Record<string | symbol, unknown>;
    rules[Symbol("hidden-rule")] = "error";

    expect(() =>
      validateManagedRuleConfiguration(
        "lint",
        rules as Parameters<typeof validateManagedRuleConfiguration>[1],
      ),
    ).toThrow(/JSON-compatible/u);
  });

  it.each([null, undefined])(
    "rejects a non-record rule map at the JSON boundary: %j",
    (rules) => {
      expect(() =>
        validateManagedRuleConfiguration(
          "lint",
          rules as unknown as Parameters<
            typeof validateManagedRuleConfiguration
          >[1],
        ),
      ).toThrow(/JSON-compatible/u);
    },
  );

  it("exposes only managed lint-owned rules in the inventory", () => {
    const inventory = managedRuleInventory("lint");

    expect(inventory.has("no-console")).toBe(true);
    expect(inventory.has("@typescript-eslint/no-unused-vars")).toBe(true);
    expect(inventory.has("jsx-a11y/no-autofocus")).toBe(false);
  });

  it("returns an inventory view that cannot mutate canonical ownership", () => {
    const inventory = managedRuleInventory("lint");
    const coreRule = inventory.get("no-console");
    expect(coreRule).toBeDefined();

    expect(() => {
      (inventory as Map<string, typeof coreRule>).set(
        "company/private-rule",
        coreRule,
      );
    }).toThrow();

    expect(managedRuleInventory("lint").has("company/private-rule")).toBe(
      false,
    );
    expect(() =>
      validateManagedRuleConfiguration("lint", {
        "company/private-rule": "error",
      }),
    ).toThrow(/unsupported rule/u);
  });
});
