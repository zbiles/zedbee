import { describe, expect, it } from "vitest";
import { createFilePolicyResolver } from "../../src/config/file-policy.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { configFileSchema } from "../../src/config/schema.js";
import type { ChangeSet } from "../../src/git/change-set.js";

function changeSet(files: ChangeSet["files"] = new Map()): ChangeSet {
  return {
    files,
    isEmpty: files.size === 0,
    containsAddedLine: () => false,
  };
}

describe("createFilePolicyResolver", () => {
  it("allows basic lint only for explicitly selected TypeScript files", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      overrides: [
        {
          files: ["tools/*.ts"],
          checks: { lint: { typeInformation: "when-available" } },
        },
      ],
    });
    const resolve = createFilePolicyResolver(config, changeSet());

    expect(resolve("lint", "tools/config.ts", "target").typeInformation).toBe(
      "when-available",
    );
    expect(resolve("lint", "src/app.ts", "target").typeInformation).toBe(
      "required",
    );
  });

  it("rejects workspace-wide duplication fields in file overrides", () => {
    for (const duplication of [
      { threshold: 7.5 },
      { settings: { minLines: 8 } },
    ]) {
      expect(
        configFileSchema.safeParse({
          schemaVersion: 1,
          overrides: [{ files: ["src/**"], checks: { duplication } }],
        }).success,
      ).toBe(false);
    }
    expect(
      configFileSchema.safeParse({
        schemaVersion: 1,
        overrides: [
          { files: ["src/**"], checks: { duplication: { severity: "warn" } } },
        ],
      }).success,
    ).toBe(true);
  });

  it("matches each actual repository file instead of the containing workspace", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: {
        lint: {
          severity: "error",
          rules: { "no-console": "error" },
        },
      },
      overrides: [
        {
          files: ["test/**"],
          checks: {
            lint: {
              severity: "warn",
              rules: { "no-console": "off" },
            },
          },
        },
      ],
    });
    const resolve = createFilePolicyResolver(config, changeSet());

    expect(resolve("lint", "src/app.ts", "target").rules["no-console"]).toBe(
      "error",
    );
    expect(
      resolve("lint", "test/app.test.ts", "target").rules["no-console"],
    ).toBe("off");
    expect(resolve("lint", "src/app.ts", "target").severity).toBe("error");
    expect(resolve("lint", "test/app.test.ts", "target").severity).toBe("warn");
  });

  it("uses a renamed target path for policy on both snapshot sides", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: { severity: "error", rules: { "no-console": "error" } } },
      overrides: [
        {
          files: ["test/**"],
          checks: {
            lint: { severity: "warn", rules: { "no-console": "off" } },
          },
        },
      ],
    });
    const renamed = {
      path: "test/new.test.ts",
      previousPath: "src/old.ts",
      status: "renamed" as const,
      addedRanges: [],
    };
    const resolve = createFilePolicyResolver(
      config,
      changeSet(new Map([[renamed.path, renamed]])),
    );

    expect(resolve("lint", "src/old.ts", "baseline")).toEqual(
      resolve("lint", "test/new.test.ts", "target"),
    );
  });

  it("rejects a renamed change without its baseline path", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
    });
    const renamed = {
      path: "src/new.ts",
      status: "renamed" as const,
      addedRanges: [],
    };

    expect(() =>
      createFilePolicyResolver(
        config,
        changeSet(new Map([[renamed.path, renamed]])),
      ),
    ).toThrow(TypeError);
  });

  it("applies every matching patch in declaration order", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: { severity: "error", rules: { "no-console": "error" } } },
      overrides: [
        {
          files: ["src/**"],
          checks: {
            lint: { severity: "warn", rules: { "no-console": "warn" } },
          },
        },
        {
          files: ["src/app.ts"],
          checks: { lint: { rules: { "no-console": "off" } } },
        },
      ],
    });
    const resolve = createFilePolicyResolver(config, changeSet());

    expect(resolve("lint", "./src\\app.ts", "target")).toMatchObject({
      severity: "warn",
      rules: { "no-console": "off" },
    });
    expect(resolve("lint", "scripts/app.ts", "target")).toEqual(
      config.checks.lint,
    );
  });
});
