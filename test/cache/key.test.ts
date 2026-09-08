import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createObservationCacheKey,
  createObservationCacheKeyBuilder,
  effectiveBehaviorFingerprint,
  observationCacheEngineIdentity,
} from "../../src/cache/key.js";
import {
  ObservationCacheStore,
  type ObservationCache,
} from "../../src/cache/store.js";
import type {
  CheckAdapter,
  CheckObservationSet,
  CheckRunContext,
} from "../../src/checks/adapter.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import { createObservationCacheEngineIdentityResolver } from "../../src/checks/engine-identity.js";
import { duplicationAdapter } from "../../src/checks/duplication/adapter.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { CheckId, ResolvedConfig } from "../../src/config/schema.js";
import type { ChangeSet, ChangedFile } from "../../src/git/change-set.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";

// Count real filesystem work without replacing reads or registry validation.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
beforeEach(() => vi.clearAllMocks());

function contextFor(
  snapshotRoot: string,
  specifier: string,
  config = resolveConfig({ schemaVersion: 1, profile: "fast" }),
  sourceFiles: readonly string[] = ["src/value.ts"],
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
      files: new Map(
        sourceFiles.map((path) => [
          path,
          {
            path,
            status: "modified" as const,
            addedRanges: [{ start: 1, end: 1 }],
          },
        ]),
      ),
      isEmpty: sourceFiles.length === 0,
      containsAddedLine: () => false,
    },
    config,
    snapshots: {
      baselineDir: snapshotRoot,
      targetDir: snapshotRoot,
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
    },
    baselineInspection: inspection,
    targetInspection: inspection,
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: config.checks.cyclomaticComplexity,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

const adapter = {
  id: "cyclomaticComplexity",
  output: "observations",
  inspect: async () => ({
    applies: true as const,
    executionClass: "lightweight" as const,
    requiresBaseline: false,
    targets: [{ id: ".", kind: "repository" as const, relativeRoot: "." }],
  }),
  collect: async (context) => ({
    checkId: "cyclomaticComplexity",
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
  it.each([
    {
      checkId: "cyclomaticComplexity",
      legacyIdentity:
        "eslint@101.2.3+typescript-eslint@102.3.4+typescript@103.4.5+complexity-v1",
    },
    {
      checkId: "readabilityComplexity",
      legacyIdentity:
        "eslint@101.2.3+typescript-eslint@102.3.4+typescript@103.4.5+zedbee-readability-v1",
    },
  ] as const)(
    "misses a completed $checkId entry from the obsolete engine revision",
    async ({ checkId, legacyIdentity }) => {
      const fixture = await createInspectionFixture();
      await fixture.write("src/value.ts", "export const value = 1;\n");
      const values = new Map<string, CheckObservationSet>();
      const cache: ObservationCache = {
        get: async (key) => values.get(key),
        set: async (key, value) => {
          values.set(key, value);
        },
      };
      const context = contextFor(fixture.root, "^19.0.0");
      let collections = 0;
      const countingAdapter: CheckAdapter = {
        ...adapter,
        id: checkId,
        collect: async (run) => {
          collections += 1;
          return {
            checkId,
            target: run.target,
            baselineObservations: [],
            targetObservations: [],
          };
        },
      };

      await dispatchChecks([countingAdapter], context, {
        cache,
        cacheEngineIdentity: () => legacyIdentity,
      });
      const versions = new Map([
        ["eslint", "101.2.3"],
        ["typescript-eslint", "102.3.4"],
        ["typescript", "103.4.5"],
      ]);
      const currentIdentity = createObservationCacheEngineIdentityResolver(
        (name) => versions.get(name),
      )(checkId);
      if (currentIdentity === undefined) {
        throw new Error("Expected a current complexity engine identity");
      }
      await dispatchChecks([countingAdapter], context, {
        cache,
        cacheEngineIdentity: () => currentIdentity,
      });

      expect(collections).toBe(2);
    },
  );

  it("does not reuse cached duplication paths from basename normalization", async () => {
    const [fixture, cacheFixture] = await Promise.all([
      createInspectionFixture(),
      createInspectionFixture(),
    ]);
    const source = [
      "export function example(value: number) {",
      "  const result = {};",
      ...Array.from(
        { length: 14 },
        (_, index) => `  result.item${index} = value + ${index};`,
      ),
      "  return result;",
      "}",
      "",
    ].join("\n");
    const sourceFiles = [
      "components/a/index.ts",
      "components/b/index.ts",
      "index.ts",
    ];
    await fixture.writeJson("package.json", { name: "fixture", private: true });
    await fixture.write(sourceFiles[0]!, source);
    await fixture.write(sourceFiles[1]!, source);
    await fixture.write("index.ts", "export const unrelated = true;\n");
    const inspection = await inspectRepository(fixture.root);
    const config = resolveConfig({
      schemaVersion: 1,
      checks: { duplication: { severity: "error", threshold: 0 } },
    });
    const context = {
      ...contextFor(inspection.snapshotRoot, "^19.0.0", config, sourceFiles),
      baselineInspection: inspection,
      targetInspection: inspection,
    };
    const cache = new ObservationCacheStore({ root: cacheFixture.root });
    const legacyOptions = {
      cache,
      cacheEngineIdentity: () => "jscpd@5.0.15+zedbee-clone-normalization-v1",
    };
    // The previous adapter accepted nested index.ts clones as root index.ts
    // when the unrelated root file was also in the inspected source inventory.
    const legacyAdapter = {
      ...duplicationAdapter,
      collect: async (context: CheckRunContext) => ({
        checkId: "duplication",
        target: context.target,
        baselineObservations: [],
        targetObservations: [1, 2].map((fragment) => ({
          check: "duplication",
          rule: "duplicate-fragment",
          identity: `clone:legacy/fragment=${fragment}`,
          severity: "error" as const,
          message: "Duplicated code exceeds the configured project threshold.",
          location: { file: "index.ts", startLine: 1, endLine: 18 },
        })),
      }),
    };
    await dispatchChecks([legacyAdapter], context, legacyOptions);
    const [legacyHit] = await dispatchChecks(
      [
        {
          ...legacyAdapter,
          collect: async () => {
            throw new Error("Expected cached legacy observations");
          },
        },
      ],
      context,
      legacyOptions,
    );
    expect(legacyHit?.result.status).toBe("completed");
    expect(
      legacyHit?.result.findings.map(({ location }) => location?.file),
    ).toEqual(["index.ts", "index.ts"]);

    const [current] = await dispatchChecks([duplicationAdapter], context, {
      cache,
    });

    expect(current?.result.status).toBe("completed");
    expect(
      current?.result.findings.map(({ location }) => location?.file).sort(),
    ).toEqual(["components/a/index.ts", "components/b/index.ts"]);
  });

  it("inventories and hashes each snapshot once across concurrent checks and workspaces", async () => {
    const [baseline, target] = await Promise.all([
      createInspectionFixture(),
      createInspectionFixture(),
    ]);
    const roots = ["one", "two"];
    for (const fixture of [baseline, target]) {
      for (const root of roots) {
        await fixture.write(`${root}/value.ts`, "export const value = 1;\n");
      }
    }
    const config = resolveConfig({
      schemaVersion: 1,
      checks: {
        cyclomaticComplexity: { severity: "error" },
        readabilityComplexity: { severity: "error" },
      },
    });
    const context = contextFor(
      target.root,
      "^19.0.0",
      config,
      roots.map((root) => `${root}/value.ts`),
    );
    const workspaces = roots.map((root) => ({
      ...context.targetInspection.workspaces[0]!,
      relativeRoot: root,
      manifestPath: `${root}/package.json`,
      sourceFiles: [`${root}/value.ts`],
    }));
    const inputs: CheckRunContext = {
      ...context,
      snapshots: { ...context.snapshots, baselineDir: baseline.root },
      baselineInspection: {
        ...context.baselineInspection,
        snapshotRoot: baseline.root,
        workspaces,
      },
      targetInspection: { ...context.targetInspection, workspaces },
    };
    const checks = ["cyclomaticComplexity", "readabilityComplexity"].map(
      (id) => ({
        ...adapterFor(id),
        inspect: async () => ({
          applies: true as const,
          executionClass: "lightweight" as const,
          requiresBaseline: false,
          targets: roots.map((root) => ({
            id: root,
            kind: "workspace" as const,
            relativeRoot: root,
          })),
        }),
      }),
    );
    const keys: string[] = [];
    const streamReads = vi.mocked(fs.createReadStream);
    const inventories = vi.mocked(fsPromises.readdir);
    const results = await dispatchChecks(checks, inputs, {
      cache: {
        get: async (key) => {
          keys.push(key);
          return undefined;
        },
        set: async () => undefined,
      },
    });

    expect(results.map(({ result }) => result.status)).toEqual(
      Array(4).fill("completed"),
    );
    expect(new Set(keys).size).toBe(4);
    // Two files and three directories per snapshot, regardless of key count.
    expect(streamReads).toHaveBeenCalledTimes(4);
    expect(inventories).toHaveBeenCalledTimes(6);
  });

  it.each(["disabled", "uncacheable", "skipped"])(
    "does not inventory snapshots when caching is %s",
    async (mode) => {
      const fixture = await createInspectionFixture();
      await fixture.write("src/value.ts", "export const value = 1;\n");
      const streamReads = vi.mocked(fs.createReadStream);
      const inventories = vi.mocked(fsPromises.readdir);
      const cache: ObservationCache = {
        get: async () => {
          throw new Error("unexpected cache read");
        },
        set: async () => {
          throw new Error("unexpected cache write");
        },
      };
      const results = await dispatchChecks(
        [
          mode === "skipped"
            ? {
                ...adapter,
                inspect: async () => ({
                  applies: false as const,
                  reason: "No applicable source.",
                }),
              }
            : adapter,
        ],
        contextFor(fixture.root, "^19.0.0"),
        {
          ...(mode === "disabled" ? {} : { cache }),
          ...(mode === "uncacheable"
            ? { cacheEngineIdentity: () => undefined }
            : {}),
        },
      );

      expect(results[0]?.result.status).toBe(
        mode === "skipped" ? "skipped" : "completed",
      );
      expect(streamReads).not.toHaveBeenCalled();
      expect(inventories).not.toHaveBeenCalled();
    },
  );

  it("invalidates shared snapshot identities between dispatches at the same paths", async () => {
    const [baseline, target] = await Promise.all([
      createInspectionFixture(),
      createInspectionFixture(),
    ]);
    await baseline.write("src/value.ts", "export const value = 1;\n");
    await target.write("src/value.ts", "export const value = 2;\n");
    const context = contextFor(target.root, "^19.0.0");
    const inputs = {
      ...context,
      snapshots: { ...context.snapshots, baselineDir: baseline.root },
    };
    const keys: string[] = [];
    const cache: ObservationCache = {
      get: async (key) => {
        keys.push(key);
        return undefined;
      },
      set: async () => undefined,
    };
    await dispatchChecks([adapter], inputs, { cache });
    await target.write("src/value.ts", "export const value = 3;\n");
    await dispatchChecks([adapter], inputs, { cache });
    await baseline.write("src/value.ts", "export const value = 0;\n");
    await dispatchChecks([adapter], inputs, { cache });

    expect(new Set(keys).size).toBe(3);
  });

  it("hits only for the same source mode and exact revision comparison", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("src/value.ts", "export const value = 1;\n");
    const values = new Map<string, CheckObservationSet>();
    const cache: ObservationCache = {
      get: async (key) => values.get(key),
      set: async (key, value) => {
        values.set(key, value);
      },
    };
    let collections = 0;
    const countingAdapter: CheckAdapter = {
      ...adapter,
      collect: async (context) => {
        collections += 1;
        return adapter.collect(context);
      },
    };
    const indexContext = contextFor(fixture.root, "^19.0.0");
    const baseContext = {
      ...indexContext,
      snapshots: {
        ...indexContext.snapshots,
        baselineRef: "a".repeat(40),
        targetRef: "b".repeat(40),
      },
    };
    const otherRevisionContext = {
      ...baseContext,
      snapshots: {
        ...baseContext.snapshots,
        targetRef: "c".repeat(40),
      },
    };

    await dispatchChecks([countingAdapter], indexContext, { cache });
    await dispatchChecks([countingAdapter], indexContext, { cache });
    expect(collections).toBe(1);
    await dispatchChecks([countingAdapter], baseContext, { cache });
    expect(collections).toBe(2);
    await dispatchChecks([countingAdapter], baseContext, { cache });
    expect(collections).toBe(2);
    await dispatchChecks([countingAdapter], otherRevisionContext, { cache });
    expect(collections).toBe(3);
  });

  it("falls back for every check after unsafe snapshot inventory and recovers on the next dispatch", async () => {
    const [fixture, outside] = await Promise.all([
      createInspectionFixture(),
      createInspectionFixture(),
    ]);
    await fixture.write("src/value.ts", "export const value = 1;\n");
    await outside.write("private.txt", "must not be read");
    await fixture.symlink(join(outside.root, "private.txt"), "escape.txt");
    const keys: string[] = [];
    const collected: string[] = [];
    const checks = ["cyclomaticComplexity", "readabilityComplexity"].map(
      (id) => ({
        ...adapter,
        id,
        collect: async (context: CheckRunContext) => {
          collected.push(id);
          return {
            checkId: id,
            target: context.target,
            baselineObservations: [],
            targetObservations: [],
          };
        },
      }),
    );
    const config = resolveConfig({
      schemaVersion: 1,
      checks: {
        cyclomaticComplexity: { severity: "error" },
        readabilityComplexity: { severity: "error" },
      },
    });
    const inputs = contextFor(fixture.root, "^19.0.0", config);
    const cache: ObservationCache = {
      get: async (key) => {
        keys.push(key);
        return undefined;
      },
      set: async () => undefined,
    };
    const streamReads = vi.mocked(fs.createReadStream);
    const results = await dispatchChecks(checks, inputs, { cache });

    expect(results.map(({ result }) => result.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(collected.sort()).toEqual([
      "cyclomaticComplexity",
      "readabilityComplexity",
    ]);
    expect(keys).toHaveLength(0);
    expect(streamReads).not.toHaveBeenCalled();
    await fsPromises.rm(join(fixture.root, "escape.txt"));
    await dispatchChecks(checks, inputs, { cache });
    expect(new Set(keys).size).toBe(2);
  });

  it("retains v2 key bytes including source identity and symlinks", async () => {
    const [baseline, target] = await Promise.all([
      createInspectionFixture(),
      createInspectionFixture(),
    ]);
    await baseline.write("value.txt", "alpha\n");
    await target.write("value.txt", "beta\n");
    await baseline.symlink("value.txt", "alias.txt");
    await target.symlink("value.txt", "alias.txt");
    const input = {
      checkId: "cyclomaticComplexity",
      engineIdentity: "test-engine-v1",
      policy: {
        severity: "error" as const,
        when: "relevant" as const,
        max: 20,
        blockWorsening: true,
      },
      checkTarget: {
        id: ".",
        kind: "repository" as const,
        relativeRoot: ".",
      },
      baselineRoot: baseline.root,
      targetRoot: target.root,
      mode: "index" as const,
      baseline: "HEAD" as const,
      target: "index" as const,
      relevantConfig: { max: 20, blockWorsening: true },
      nodeVersion: "24.0.0",
      platform: "linux",
      arch: "x64",
      zedbeeVersion: "0.1.0",
    };
    const original = await createObservationCacheKey(input);
    expect(original).toBe(
      "9430489187eb4e81c195470e6cbf8c60e041bd3742b2b1636580902f549c667e",
    );
    const cacheKeyFor = createObservationCacheKeyBuilder(
      baseline.root,
      target.root,
      { mode: "index", baseline: "HEAD", target: "index" },
    );
    expect(await cacheKeyFor(input)).toBe(
      "9430489187eb4e81c195470e6cbf8c60e041bd3742b2b1636580902f549c667e",
    );
    await target.write("value.txt", "changed\n");
    expect(await createObservationCacheKey(input)).not.toBe(original);
  });

  it("versions React correctness calibration in the engine identity", () => {
    expect(observationCacheEngineIdentity("reactCorrectness")).toContain(
      "zedbee-react-calibration-v2",
    );
  });

  it("does not assign an engine identity to installed-dependency checks", () => {
    expect(observationCacheEngineIdentity("lint")).toBeUndefined();
    expect(observationCacheEngineIdentity("types")).toBeUndefined();
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

    await dispatchChecks(
      [adapterFor("reactCorrectness")],
      contextFor(fixture.root, "^18.2.0"),
      {
        cache,
      },
    );
    await dispatchChecks(
      [adapterFor("reactCorrectness")],
      contextFor(fixture.root, "^19.0.0"),
      {
        cache,
      },
    );

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
