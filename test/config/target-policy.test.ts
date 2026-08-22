import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/profiles.js";
import { resolveTargetPolicy } from "../../src/config/target-policy.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";

const inspection: RepositoryInspection = {
  snapshotRoot: "/tmp/target",
  packageManager: "pnpm",
  lockfiles: ["pnpm-lock.yaml"],
  workspaces: [
    {
      relativeRoot: ".",
      manifestPath: "package.json",
      sourceFiles: ["src/root.ts"],
      tsconfigPaths: ["tsconfig.json"],
      environments: ["javascript", "typescript"],
      dependencyDeclarations: [],
    },
    {
      relativeRoot: "apps/web",
      manifestPath: "apps/web/package.json",
      sourceFiles: ["apps/web/src/app.tsx", "apps/web/test/app.test.tsx"],
      tsconfigPaths: ["apps/web/tsconfig.json"],
      environments: ["javascript", "typescript", "react", "react-dom"],
      dependencyDeclarations: [],
    },
  ],
};

describe("resolveTargetPolicy", () => {
  it("inherits root policy and applies matching patches in declaration order", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "thorough",
      checks: {
        cyclomaticComplexity: { severity: "warn", when: "always", max: 20 },
      },
      overrides: [
        {
          files: ["apps/*"],
          checks: { cyclomaticComplexity: { max: 15 } },
        },
        {
          files: ["apps/web/src/**"],
          checks: { cyclomaticComplexity: { severity: "error" } },
        },
        {
          files: ["apps/web/test/**"],
          checks: { cyclomaticComplexity: { max: 30 } },
        },
      ],
    });

    expect(
      resolveTargetPolicy(
        config,
        "cyclomaticComplexity",
        { id: "apps/web", kind: "workspace", relativeRoot: "apps/web" },
        inspection,
      ),
    ).toEqual({
      severity: "error",
      when: "always",
      max: 30,
      blockWorsening: true,
    });
  });

  it("matches only normalized paths supplied by inspection", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      overrides: [
        { files: ["private/**"], checks: { lint: "off" } },
        { files: ["apps/web/tsconfig.json"], checks: { lint: "warn" } },
      ],
    });

    expect(
      resolveTargetPolicy(
        config,
        "lint",
        { id: "apps/web", kind: "workspace", relativeRoot: "apps/web" },
        inspection,
      ).severity,
    ).toBe("warn");
  });

  it("rejects targets that were not produced by inspection", () => {
    const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
    expect(() =>
      resolveTargetPolicy(
        config,
        "lint",
        { id: "../escape", kind: "workspace", relativeRoot: "../escape" },
        inspection,
      ),
    ).toThrow("inspected workspace");
  });

  it("resolves the repository target even when the snapshot has no package manifest", () => {
    const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
    expect(
      resolveTargetPolicy(
        config,
        "formatting",
        { id: ".", kind: "repository", relativeRoot: "." },
        { ...inspection, workspaces: [] },
      ),
    ).toEqual(config.checks.formatting);
  });

  it("rejects a programmatically injected file-scoped availability policy", () => {
    const base = resolveConfig({ schemaVersion: 1, profile: "thorough" });
    const config = {
      ...base,
      overrides: [
        {
          files: ["package.json"],
          checks: { vulnerabilities: { onUnavailable: "warn" as const } },
        },
      ],
    };

    expect(() =>
      resolveTargetPolicy(
        config as unknown as typeof base,
        "vulnerabilities",
        { id: ".", kind: "repository", relativeRoot: "." },
        inspection,
      ),
    ).toThrow("availability policy cannot be overridden");
  });

  it("matches repository targets against every inspector-produced workspace path", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: "warn" },
      overrides: [
        { files: ["apps/web/src/**"], checks: { formatting: "error" } },
      ],
    });

    expect(
      resolveTargetPolicy(
        config,
        "formatting",
        { id: "repository-output", kind: "repository", relativeRoot: "." },
        inspection,
      ).severity,
    ).toBe("error");
  });
});
