import { describe, expect, it } from "vitest";
import { configFileSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";
import {
  resolveTargetPolicy,
  assertProjectEslintConfiguration,
} from "../../src/config/target-policy.js";
import {
  managedPolicyScalarKeys,
  snapshotManagedPolicy,
} from "../../src/config/settings-registry.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";

const inspection: RepositoryInspection = {
  snapshotRoot: "/captured",
  packageManager: "npm",
  lockfiles: [],
  workspaces: [".", "packages/ui", "packages/api"].map((relativeRoot) => ({
    relativeRoot,
    manifestPath:
      relativeRoot === "." ? "package.json" : `${relativeRoot}/package.json`,
    sourceFiles: [
      relativeRoot === "." ? "src/app.js" : `${relativeRoot}/src/app.tsx`,
    ],
    tsconfigPaths: [],
    environments: [],
    dependencyDeclarations: [],
  })),
};
function config(value: unknown) {
  return resolveConfig(configFileSchema.parse(value));
}
function lint(value: unknown, relativeRoot = "packages/ui") {
  return resolveTargetPolicy(
    config(value),
    "lint",
    { id: relativeRoot, relativeRoot, kind: "workspace" },
    inspection,
  );
}

describe("project ESLint configuration", () => {
  it("keeps managed lint and redacted project messages as defaults", () => {
    const resolved = resolveConfig(undefined);
    expect(resolved.checks.lint).toMatchObject({
      engine: "managed",
      severity: "error",
    });
    expect(resolved.reporting.projectEslintMessages).toBe("redacted");
    expect(managedPolicyScalarKeys("lint")).toContain("engine");
    expect(() =>
      snapshotManagedPolicy("lint", resolved.checks.lint),
    ).not.toThrow();
    expect(
      config({ schemaVersion: 1, reporting: { projectEslintMessages: "full" } })
        .reporting.projectEslintMessages,
    ).toBe("full");
  });

  it("selects project ESLint for a whole workspace without changing check severities", () => {
    const input = {
      schemaVersion: 1,
      overrides: [
        { files: ["packages/ui/**"], checks: { lint: { engine: "project" } } },
      ],
    };
    expect(lint(input)).toMatchObject({ engine: "project", severity: "error" });
    expect(lint(input, "packages/api")).toMatchObject({
      engine: "managed",
      severity: "error",
    });
    const resolved = config(input);
    expect(resolved.checks.reactCorrectness.severity).toBe("error");
    expect(resolved.checks.reactAccessibility.severity).toBe("error");
  });

  it.each([
    { files: ["**/*.tsx"] },
    { files: ["packages/ui/src/**"] },
    { files: ["packages/*/**"] },
    { files: ["packages/ui/**"], excludeFiles: ["**/test/**"] },
  ])("rejects file-scoped engine selection: %j", (scope) => {
    expect(() =>
      lint({
        schemaVersion: 1,
        overrides: [{ ...scope, checks: { lint: { engine: "project" } } }],
      }),
    ).toThrow(/workspace|engine/iu);
  });

  it.each([
    { lint: { engine: "project", severity: "off" } },
    { lint: { engine: "project", rules: { "no-console": "warn" } } },
    { lint: { engine: "project", typeInformation: "when-available" } },
    { lint: { engine: "project" }, reactCorrectness: "off" },
    { lint: { engine: "project" }, reactAccessibility: { severity: "warn" } },
    {
      lint: { engine: "project" },
      reactCorrectness: { rules: { "react/prop-types": "off" } },
    },
    {
      lint: { engine: "project" },
      reactAccessibility: { settings: { components: { Photo: "img" } } },
    },
  ])(
    "rejects root conflicts instead of silently overriding user intent: %j",
    (checks) => {
      expect(() => config({ schemaVersion: 1, checks })).toThrow(
        /project|managed/iu,
      );
    },
  );

  it("rejects inherited and later matching managed overrides in a project workspace", () => {
    for (const overrides of [
      [
        { files: ["packages/ui/**"], checks: { lint: { engine: "project" } } },
        {
          files: ["packages/ui/src/**"],
          checks: { reactAccessibility: "off" },
        },
      ],
      [
        {
          files: ["packages/ui/src/**"],
          checks: { lint: { severity: "off" } },
        },
        { files: ["packages/ui/**"], checks: { lint: { engine: "project" } } },
      ],
      [
        {
          files: ["packages/ui/src/**"],
          checks: {
            reactCorrectness: { rules: { "react/prop-types": "warn" } },
          },
        },
        { files: ["packages/ui/**"], checks: { lint: { engine: "project" } } },
      ],
    ])
      expect(() => lint({ schemaVersion: 1, overrides })).toThrow(
        /project|managed/iu,
      );
  });

  it("rejects project-owned React exclusions but preserves independent and lint exclusions", () => {
    const entry = (checks: string[]) => ({
      files: ["packages/ui/src/**"],
      checks,
      reason: "Generated",
    });
    const checks = { lint: { engine: "project" } };
    expect(() =>
      lint({
        schemaVersion: 1,
        checks,
        pathExclusions: [entry(["reactAccessibility"])],
      }),
    ).toThrow(/exclusion|project/iu);
    expect(() =>
      lint({
        schemaVersion: 1,
        checks,
        pathExclusions: [entry(["formatting", "lint"])],
      }),
    ).not.toThrow();
  });

  it("honors an override that excludes the entire selected project workspace", () => {
    expect(() =>
      lint({
        schemaVersion: 1,
        overrides: [
          {
            files: ["packages/ui/**"],
            checks: { lint: { engine: "project" } },
          },
          {
            files: ["**"],
            excludeFiles: ["packages/ui/**"],
            checks: { reactAccessibility: "off" },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("honors a later explicit lint severity when re-enabling a workspace", () => {
    expect(
      lint({
        schemaVersion: 1,
        checks: { lint: "off" },
        overrides: [
          {
            files: ["packages/ui/**"],
            checks: { lint: { engine: "project", severity: "error" } },
          },
        ],
      }),
    ).toMatchObject({ engine: "project", severity: "error" });
  });

  it("permits managed settings confined to another workspace and ordered return to managed mode", () => {
    const resolved = config({
      schemaVersion: 1,
      overrides: [
        { files: ["packages/ui/**"], checks: { lint: { engine: "project" } } },
        {
          files: ["packages/api/**"],
          checks: { reactAccessibility: { severity: "off" } },
        },
      ],
    });
    expect(() =>
      assertProjectEslintConfiguration(resolved, inspection),
    ).not.toThrow();
    expect(
      lint({
        schemaVersion: 1,
        overrides: [
          {
            files: ["packages/ui/**"],
            checks: { lint: { engine: "project" } },
          },
          {
            files: ["packages/ui/**"],
            checks: {
              lint: { engine: "managed", rules: { "no-console": "warn" } },
            },
          },
        ],
      }),
    ).toMatchObject({ engine: "managed", rules: { "no-console": "warn" } });
  });
});
