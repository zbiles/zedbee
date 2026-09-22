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

  it("suppresses matching paths when pathExclusions are configured", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "fast",
      checks: {
        formatting: "off",
        lint: "error",
        types: "off",
        cyclomaticComplexity: "off",
        readabilityComplexity: "off",
        structuralSecurity: "off",
        secrets: "off",
        duplication: "off",
        dependencyArchitecture: "off",
        deadCode: "off",
        reactCorrectness: "off",
        reactAccessibility: "off",
        vulnerabilities: "off",
      },
      pathExclusions: [
        {
          files: ["generated/**", "src/legacy/**"],
          checks: ["formatting", "lint"],
          reason: "Generated files are not review targets.",
        },
      ],
    });
    const resolve = createFilePolicyResolver(
      config,
      changeSet(
        new Map([
          [
            "generated/file.ts",
            {
              path: "generated/file.ts",
              status: "added",
              addedRanges: [{ start: 1, end: 1 }],
            },
          ],
        ]),
      ),
    );

    expect(resolve("lint", "generated/file.ts", "target").severity).toBe("off");
    expect(resolve("lint", "src/legacy/main.ts", "target").severity).toBe(
      "off",
    );
    expect(resolve("lint", "src/regular/main.ts", "target").severity).toBe(
      "error",
    );
    expect(resolve("formatting", "generated/file.ts", "target").severity).toBe(
      "off",
    );
    expect(resolve("types", "generated/file.ts", "target").severity).toBe(
      "off",
    );
    expect(resolve.pathExclusionsForFile).toBeDefined();
    expect(
      resolve.pathExclusionsForFile?.("lint", "generated/file.ts", "target"),
    ).toEqual([
      {
        files: ["generated/**", "src/legacy/**"],
        checks: ["formatting", "lint"],
        reason: "Generated files are not review targets.",
      },
    ]);
  });
});

it("excludes only the matching override while explicit path exclusions skip the named check", () => {
  const config = resolveConfig(
    configFileSchema.parse({
      schemaVersion: 1,
      checks: { formatting: { settings: { tabWidth: 2 } } },
      overrides: [
        {
          files: ["src/**"],
          excludeFiles: ["src/generated/**", "**/*.test.ts"],
          checks: {
            formatting: { settings: { tabWidth: 4 } },
            lint: { severity: "warn" },
          },
        },
        {
          files: ["src/generated/special.ts"],
          checks: { formatting: { settings: { tabWidth: 8 } } },
        },
      ],
      pathExclusions: [
        {
          files: ["src/vendor/**"],
          checks: ["formatting"],
          reason: "Vendor-owned formatting",
        },
      ],
    }),
  );
  const resolve = createFilePolicyResolver(
    config,
    changeSet(
      new Map([
        [
          "src/generated/renamed.ts",
          {
            path: "src/generated/renamed.ts",
            previousPath: "src/old.ts",
            status: "renamed",
            addedRanges: [],
          },
        ],
      ]),
    ),
  );
  expect(resolve("formatting", "src/app.ts", "target").settings.tabWidth).toBe(
    4,
  );
  expect(
    resolve("formatting", "src/generated/app.ts", "target").settings.tabWidth,
  ).toBe(2);
  expect(
    resolve("formatting", "src/app.test.ts", "target").settings.tabWidth,
  ).toBe(2);
  expect(
    resolve("formatting", "src/generated/special.ts", "target").settings
      .tabWidth,
  ).toBe(8);
  expect(
    resolve("formatting", "src/old.ts", "baseline").settings.tabWidth,
  ).toBe(2);
  expect(resolve("formatting", "src/vendor/app.ts", "target").severity).toBe(
    "off",
  );
  expect(
    resolve("formatting", "src/generated/app.ts", "target").severity,
  ).not.toBe("off");
  expect(resolve("lint", "src/vendor/app.ts", "target").severity).toBe("warn");
});

it("preserves ordered gitignore rules, scoped roots, directory exclusion and case", () => {
  const config = resolveConfig(
    configFileSchema.parse({
      schemaVersion: 1,
      pathExclusions: [
        {
          syntax: "gitignore",
          basePath: "packages/web",
          files: [
            "# comment",
            "*.ts",
            "!keep.ts",
            "/root.js",
            "build/",
            "!build/keep.js",
            "UPPER.js",
            "\\#literal.js",
          ],
          checks: ["formatting"],
          reason: "Imported formatter ignores",
        },
      ],
    }),
  );
  const resolve = createFilePolicyResolver(config, changeSet());
  for (const file of [
    "packages/web/drop.ts",
    "packages/web/nested/drop.ts",
    "packages/web/root.js",
    "packages/web/build/keep.js",
    "packages/web/UPPER.js",
    "packages/web/upper.js",
    "packages/web/#literal.js",
  ])
    expect(resolve("formatting", file, "target").severity, file).toBe("off");
  for (const file of [
    "packages/web/keep.ts",
    "packages/web/nested/keep.ts",
    "packages/web/nested/root.js",
    "other/drop.ts",
  ])
    expect(resolve("formatting", file, "target").severity, file).not.toBe(
      "off",
    );
  expect(resolve("lint", "packages/web/drop.ts", "target").severity).not.toBe(
    "off",
  );
});
