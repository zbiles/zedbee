import { describe, expect, it } from "vitest";
import {
  CONFIGURABLE_CHECK_IDS,
  CONFIGURABLE_RULE_CHECK_IDS,
  isConfigurableRuleCheckId,
  managedSettingDefinition,
} from "../../src/config/settings-registry.js";
import { resolveConfig } from "../../src/config/profiles.js";

describe("managed settings registry", () => {
  it("registers only the approved seven checks", () => {
    expect(CONFIGURABLE_CHECK_IDS).toEqual([
      "formatting",
      "lint",
      "cyclomaticComplexity",
      "readabilityComplexity",
      "duplication",
      "reactCorrectness",
      "reactAccessibility",
    ]);
    expect(managedSettingDefinition("types")).toBeUndefined();
    expect(CONFIGURABLE_RULE_CHECK_IDS).toEqual([
      "lint",
      "reactCorrectness",
      "reactAccessibility",
    ]);
    expect(isConfigurableRuleCheckId("lint")).toBe(true);
    expect(isConfigurableRuleCheckId("formatting")).toBe(false);
  });

  it("resolves explicit immutable managed defaults", () => {
    const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });

    expect(config.checks.formatting.settings).toMatchObject({
      printWidth: 80,
      tabWidth: 2,
      semi: true,
      singleQuote: false,
    });
    expect(config.checks.duplication).toMatchObject({
      threshold: 5,
      settings: { minLines: 5, minTokens: 50, mode: "mild" },
    });
    expect(Object.isFrozen(config.checks.formatting.settings)).toBe(true);
  });
});
