import { validateAccessibilitySettings } from "../../src/checks/react/accessibility-settings.js";
import { describe, expect, it } from "vitest";
import { configFileSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { createFilePolicyResolver } from "../../src/config/file-policy.js";
import { groupFilesByRules } from "../../src/checks/eslint/managed-config.js";
import {
  managedSettingDefinition,
  snapshotManagedPolicy,
} from "../../src/config/settings-registry.js";

function parse(settings: unknown) {
  return configFileSchema.parse({
    schemaVersion: 1,
    checks: { reactAccessibility: { settings } },
  });
}

describe("accessibility settings", () => {
  it("accepts only inert supported jsx-a11y settings", () => {
    expect(() =>
      parse({
        components: { Photo: "img" },
        attributes: { for: ["htmlFor", "for"] },
        polymorphicPropName: "as",
        polymorphicAllowList: ["Box"],
      }),
    ).not.toThrow();
    for (const settings of [
      { unknown: true },
      { components: { Photo: 1 } },
      { components: { Photo: "" } },
      { attributes: { for: "htmlFor" } },
      { polymorphicPropName: "" },
      { polymorphicAllowList: [1] },
      { components: { Photo: () => "img" } },
    ])
      expect(() => parse(settings)).toThrow();
    expect(() =>
      validateAccessibilitySettings({
        components: JSON.parse('{"__proto__":"img"}'),
      }),
    ).toThrow(/JSON-compatible/u);
  });

  it("resolves frozen defaults and registers file-scoped settings", () => {
    const config = resolveConfig(
      parse({ components: { Photo: "img" }, attributes: { for: ["htmlFor"] } }),
    );
    expect(resolveConfig(undefined).checks.reactAccessibility).toMatchObject({
      settings: {},
    });
    const policy = config.checks.reactAccessibility;
    expect(Object.isFrozen(policy.settings)).toBe(true);
    expect(Object.isFrozen(policy.settings.components)).toBe(true);
    expect(Object.isFrozen(policy.settings.attributes?.for)).toBe(true);
    expect(managedSettingDefinition("reactAccessibility")?.scope).toBe("file");
    expect(() =>
      snapshotManagedPolicy("reactAccessibility", policy),
    ).not.toThrow();
  });

  it("isolates settings per file and includes settings in stable group identities", () => {
    const config = resolveConfig(
      configFileSchema.parse({
        schemaVersion: 1,
        checks: {
          reactAccessibility: {
            settings: {
              polymorphicPropName: "as",
              components: { Photo: "img" },
            },
          },
        },
        overrides: [
          {
            files: ["packages/other/**"],
            checks: {
              reactAccessibility: {
                settings: {
                  components: { Photo: "div" },
                  polymorphicAllowList: ["Box"],
                },
              },
            },
          },
        ],
      }),
    );
    const changes = {
      files: new Map(),
      isEmpty: false,
      containsAddedLine: () => false,
    };
    const resolver = createFilePolicyResolver(config, changes);
    expect(
      resolver("reactAccessibility", "packages/other/app.tsx", "target")
        .settings,
    ).toEqual({
      polymorphicPropName: "as",
      components: { Photo: "div" },
      polymorphicAllowList: ["Box"],
    });
    const groups = groupFilesByRules(
      ["src/app.tsx", "packages/other/app.tsx"],
      "target",
      resolver,
      "reactAccessibility",
    );
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map(({ fingerprint }) => fingerprint)).size).toBe(2);
    const same = groupFilesByRules(
      ["src/app.tsx"],
      "baseline",
      resolver,
      "reactAccessibility",
    );
    expect(same[0]?.fingerprint).toBe(
      groups.find(({ files }) => files.includes("src/app.tsx"))?.fingerprint,
    );
  });
});
