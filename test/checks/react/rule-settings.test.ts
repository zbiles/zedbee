import { describe, expect, it } from "vitest";
import {
  managedRuleInventory,
  validateManagedRuleConfiguration,
} from "../../../src/checks/react/rule-settings.js";

describe("managed React rule settings", () => {
  it("accepts bounded React correctness and Hooks rule overrides", () => {
    expect(() =>
      validateManagedRuleConfiguration("reactCorrectness", {
        "react/prop-types": "off",
        "react-hooks/rules-of-hooks": "error",
      }),
    ).not.toThrow();
  });

  it("accepts bounded React accessibility rule overrides", () => {
    expect(() =>
      validateManagedRuleConfiguration("reactAccessibility", {
        "jsx-a11y/no-autofocus": "off",
      }),
    ).not.toThrow();
  });

  it("rejects React correctness rules configured on accessibility", () => {
    expect(() =>
      validateManagedRuleConfiguration("reactAccessibility", {
        "react/prop-types": "warn",
      }),
    ).toThrow(/reactCorrectness/u);
  });

  it("rejects unknown prefixes instead of loading project plugins", () => {
    expect(() =>
      validateManagedRuleConfiguration("reactCorrectness", {
        "company/private-rule": "error",
      }),
    ).toThrow(/unsupported rule/u);
  });

  it("rejects rule identifiers containing control characters", () => {
    expect(() =>
      validateManagedRuleConfiguration("reactCorrectness", {
        "react/no-danger\u0000": "error",
      }),
    ).toThrow(/control character/u);
  });

  it("exposes separate correctness and accessibility inventories", () => {
    const correctness = managedRuleInventory("reactCorrectness");
    const accessibility = managedRuleInventory("reactAccessibility");

    expect(correctness.has("react/prop-types")).toBe(true);
    expect(correctness.has("react-hooks/rules-of-hooks")).toBe(true);
    expect(correctness.has("jsx-a11y/no-autofocus")).toBe(false);
    expect(accessibility.has("jsx-a11y/no-autofocus")).toBe(true);
    expect(accessibility.has("react/prop-types")).toBe(false);
  });
});
