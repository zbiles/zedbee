import { describe, expect, it } from "vitest";
import {
  effectiveBehaviorFingerprint,
  observationCacheEngineIdentity,
} from "../../src/cache/key.js";
import type { ObservationCache } from "../../src/cache/store.js";
import type {
  CheckAdapter,
  CheckRunContext,
} from "../../src/checks/adapter.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { CheckId, ResolvedConfig } from "../../src/config/schema.js";
import type { ChangeSet, ChangedFile } from "../../src/git/change-set.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";

function contextFor(
  snapshotRoot: string,
  specifier: string,
  config = resolveConfig({ schemaVersion: 1, profile: "fast" }),
  sourceFiles: readonly string[] = [],
): CheckRunContext {
  const inspection: RepositoryInspection = {
    snapshotRoot,
    packageManager: "npm",
    lockfiles: [],
    workspaces: [
      {
        relativeRoot: ".",
        manifestPath: "package.json",
        sourceFiles,
        tsconfigPaths: [],
        environments: ["javascript"],
        dependencyDeclarations: [
          { name: "react", specifier, section: "dependencies" },
        ],
      },
    ],
  };
  return {
    repositoryRoot: snapshotRoot,
    changeSet: {
      files: new Map(),
      isEmpty: true,
      containsAddedLine: () => false,
    },
    config,
    snapshots: {
      baselineDir: snapshotRoot,
      targetDir: snapshotRoot,
      baselineRef: "HEAD",
      unsupportedEntries: [],
    },
    baselineInspection: inspection,
    targetInspection: inspection,
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: config.checks.lint,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

const adapter = {
  id: "lint",
  output: "observations",
  inspect: async () => ({
    applies: true as const,
    executionClass: "lightweight" as const,
    requiresBaseline: false,
    targets: [{ id: ".", kind: "repository" as const, relativeRoot: "." }],
  }),
  collect: async (context) => ({
    checkId: "lint",
    target: context.target,
    baselineObservations: [],
    targetObservations: [],
  }),
} satisfies CheckAdapter;

function adapterFor(id: string): CheckAdapter {
  return {
    ...adapter,
    id,
    collect: async (context) => ({
      checkId: id,
      target: context.target,
      baselineObservations: [],
      targetObservations: [],
    }),
  };
}

const unchanged: ChangeSet = {
  files: new Map(),
  isEmpty: true,
  containsAddedLine: () => false,
};

function changed(...files: readonly ChangedFile[]): ChangeSet {
  return {
    files: new Map(files.map((file) => [file.path, file])),
    isEmpty: files.length === 0,
    containsAddedLine: () => false,
  };
}

function behavior(
  config: ResolvedConfig,
  checkId: CheckId,
  paths: readonly string[] = [],
  changeSet: ChangeSet = unchanged,
) {
  return effectiveBehaviorFingerprint(config, checkId, paths, changeSet);
}

describe("observation cache keys", () => {
  it("versions React correctness calibration in the engine identity", () => {
    expect(observationCacheEngineIdentity("reactCorrectness")).toContain(
      "zedbee-react-calibration-v2",
    );
  });

  it("separates otherwise identical inspections by staged React declaration", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("src/value.ts", "export const value = 1;\n");
    const keys: string[] = [];
    const cache: ObservationCache = {
      get: async (key) => {
        keys.push(key);
        return undefined;
      },
      set: async () => undefined,
    };

    await dispatchChecks([adapter], contextFor(fixture.root, "^18.2.0"), {
      cache,
    });
    await dispatchChecks([adapter], contextFor(fixture.root, "^19.0.0"), {
      cache,
    });

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("uses each analyzer's exact extension case semantics in file behavior mapping", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("src/value.ts", "export const value = 1;\n");
    const paths = ["src/value.ts", "src/ignored.TS"];
    const keyPair = async (
      checkId: CheckId,
      base: ResolvedConfig,
      withUppercaseOverride: ResolvedConfig,
    ): Promise<readonly string[]> => {
      const keys: string[] = [];
      const cache: ObservationCache = {
        get: async (key) => {
          keys.push(key);
          return undefined;
        },
        set: async () => undefined,
      };
      await dispatchChecks(
        [adapterFor(checkId)],
        contextFor(fixture.root, "^19.0.0", base, paths),
        { cache },
      );
      await dispatchChecks(
        [adapterFor(checkId)],
        contextFor(fixture.root, "^19.0.0", withUppercaseOverride, paths),
        { cache },
      );
      return keys;
    };

    const lintBase = resolveConfig({
      schemaVersion: 1,
      checks: {
        lint: { severity: "error", rules: { "no-console": "warn" } },
      },
    });
    const lintOverride = resolveConfig({
      schemaVersion: 1,
      checks: {
        lint: { severity: "error", rules: { "no-console": "warn" } },
      },
      overrides: [
        {
          files: ["src/ignored.TS"],
          checks: { lint: { rules: { "no-console": "error" } } },
        },
      ],
    });
    const reactBase = resolveConfig({
      schemaVersion: 1,
      checks: {
        reactCorrectness: {
          severity: "error",
          rules: { "react/jsx-key": "warn" },
        },
      },
    });
    const reactOverride = resolveConfig({
      schemaVersion: 1,
      checks: {
        reactCorrectness: {
          severity: "error",
          rules: { "react/jsx-key": "warn" },
        },
      },
      overrides: [
        {
          files: ["src/ignored.TS"],
          checks: {
            reactCorrectness: { rules: { "react/jsx-key": "error" } },
          },
        },
      ],
    });
    const complexityBase = resolveConfig({
      schemaVersion: 1,
      checks: { cyclomaticComplexity: { severity: "error", max: 10 } },
    });
    const complexityOverride = resolveConfig({
      schemaVersion: 1,
      checks: { cyclomaticComplexity: { severity: "error", max: 10 } },
      overrides: [
        {
          files: ["src/ignored.TS"],
          checks: { cyclomaticComplexity: { max: 20 } },
        },
      ],
    });

    const lintKeys = await keyPair("lint", lintBase, lintOverride);
    const reactKeys = await keyPair(
      "reactCorrectness",
      reactBase,
      reactOverride,
    );
    const complexityKeys = await keyPair(
      "cyclomaticComplexity",
      complexityBase,
      complexityOverride,
    );

    expect(lintKeys).toHaveLength(2);
    expect(lintKeys[0]).toBe(lintKeys[1]);
    expect(reactKeys).toHaveLength(2);
    expect(reactKeys[0]).not.toBe(reactKeys[1]);
    expect(complexityKeys).toHaveLength(2);
    expect(complexityKeys[0]).not.toBe(complexityKeys[1]);
  });

  it.each([
    {
      name: "formatting singleQuote",
      checkId: "formatting" as const,
      left: resolveConfig({
        schemaVersion: 1,
        checks: { formatting: { settings: { singleQuote: false } } },
      }),
      right: resolveConfig({
        schemaVersion: 1,
        checks: { formatting: { settings: { singleQuote: true } } },
      }),
    },
    {
      name: "lint no-console rule",
      checkId: "lint" as const,
      left: resolveConfig({
        schemaVersion: 1,
        checks: { lint: { rules: { "no-console": "warn" } } },
      }),
      right: resolveConfig({
        schemaVersion: 1,
        checks: { lint: { rules: { "no-console": "error" } } },
      }),
    },
    {
      name: "React rule options",
      checkId: "reactCorrectness" as const,
      left: resolveConfig({
        schemaVersion: 1,
        checks: {
          reactCorrectness: {
            rules: {
              "react/jsx-key": ["error", { checkFragmentShorthand: false }],
            },
          },
        },
      }),
      right: resolveConfig({
        schemaVersion: 1,
        checks: {
          reactCorrectness: {
            rules: {
              "react/jsx-key": ["error", { checkFragmentShorthand: true }],
            },
          },
        },
      }),
    },
    {
      name: "complexity maximum",
      checkId: "cyclomaticComplexity" as const,
      left: resolveConfig({
        schemaVersion: 1,
        checks: { cyclomaticComplexity: { max: 10 } },
      }),
      right: resolveConfig({
        schemaVersion: 1,
        checks: { cyclomaticComplexity: { max: 11 } },
      }),
    },
    {
      name: "complexity worsening policy",
      checkId: "readabilityComplexity" as const,
      left: resolveConfig({
        schemaVersion: 1,
        checks: { readabilityComplexity: { blockWorsening: true } },
      }),
      right: resolveConfig({
        schemaVersion: 1,
        checks: { readabilityComplexity: { blockWorsening: false } },
      }),
    },
    {
      name: "duplication minTokens",
      checkId: "duplication" as const,
      left: resolveConfig({
        schemaVersion: 1,
        checks: { duplication: { settings: { minTokens: 50 } } },
      }),
      right: resolveConfig({
        schemaVersion: 1,
        checks: { duplication: { settings: { minTokens: 75 } } },
      }),
    },
  ])("separates $name behavior", ({ checkId, left, right }) => {
    expect(behavior(left, checkId)).not.toEqual(behavior(right, checkId));
  });

  it("separates a matching override but ignores an unrelated override", () => {
    const root = resolveConfig({
      schemaVersion: 1,
      checks: { lint: { rules: { "no-console": "warn" } } },
    });
    const overridden = resolveConfig({
      schemaVersion: 1,
      checks: { lint: { rules: { "no-console": "warn" } } },
      overrides: [
        {
          files: ["src/**"],
          checks: { lint: { rules: { "no-console": "error" } } },
        },
      ],
    });

    expect(behavior(root, "lint", ["src/value.ts"])).not.toEqual(
      behavior(overridden, "lint", ["src/value.ts"]),
    );
    expect(behavior(root, "lint", ["test/value.ts"])).toEqual(
      behavior(overridden, "lint", ["test/value.ts"]),
    );
  });

  it("normalizes target rename policy paths before fingerprinting", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      checks: { lint: { rules: { "no-console": "warn" } } },
      overrides: [
        {
          files: ["test/**"],
          checks: { lint: { rules: { "no-console": "off" } } },
        },
      ],
    });
    const changeSet = changed({
      path: "test/new.test.ts",
      previousPath: "src/old.ts",
      status: "renamed",
      addedRanges: [],
    });

    expect(behavior(config, "lint", ["src/old.ts"], changeSet).files).toEqual([
      {
        path: "test/new.test.ts",
        policy: expect.objectContaining({
          rules: expect.objectContaining({ "no-console": "off" }),
        }),
      },
    ]);
  });

  it("retains option-array order while ignoring object and rule insertion order", () => {
    const left = resolveConfig({
      schemaVersion: 1,
      checks: {
        lint: {
          rules: {
            "no-console": ["warn", { allow: ["warn", "error"] }],
            eqeqeq: "error",
          },
        },
      },
    });
    const equivalent = resolveConfig({
      schemaVersion: 1,
      checks: {
        lint: {
          rules: {
            eqeqeq: "error",
            "no-console": ["warn", { allow: ["warn", "error"] }],
          },
        },
      },
    });
    const reorderedOptions = resolveConfig({
      schemaVersion: 1,
      checks: {
        lint: {
          rules: {
            eqeqeq: "error",
            "no-console": ["warn", { allow: ["error", "warn"] }],
          },
        },
      },
    });

    expect(behavior(left, "lint", ["z.ts", "a.ts"])).toEqual(
      behavior(equivalent, "lint", ["a.ts", "z.ts"]),
    );
    expect(behavior(left, "lint", ["z.ts", "a.ts"])).not.toEqual(
      behavior(reorderedOptions, "lint", ["a.ts", "z.ts"]),
    );
  });

  it("includes the selected behavior profile", () => {
    const fast = resolveConfig({ schemaVersion: 1, profile: "fast" });
    const recommended = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
    });

    expect(behavior(fast, "lint")).not.toEqual(behavior(recommended, "lint"));
  });

  it("excludes configuration paths and presentation-only origins", () => {
    const config = resolveConfig(
      {
        schemaVersion: 1,
        checks: { lint: { rules: { "no-console": "warn" } } },
      },
      "/repo/.zedbeerc.jsonc",
    );
    const relabeled = {
      ...config,
      configPath: "/private/presentation-only.jsonc",
      configurationOrigins: Object.freeze({
        ...config.configurationOrigins,
        lint: Object.freeze({
          ...config.configurationOrigins.lint,
          rules: Object.freeze({
            kind: "repository" as const,
            configPath: "/private/presentation-only.jsonc",
          }),
        }),
      }),
    };

    expect(behavior(config, "lint", ["src/value.ts"])).toEqual(
      behavior(relabeled, "lint", ["src/value.ts"]),
    );
  });
});
