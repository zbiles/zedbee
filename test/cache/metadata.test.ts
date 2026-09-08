import { describe, expect, it, vi } from "vitest";
import type {
  CheckAdapter,
  CheckObservationSet,
} from "../../src/checks/adapter.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import {
  CHECK_METADATA,
  isCacheableObservationCheck,
} from "../../src/checks/metadata.js";
import {
  createObservationCacheEngineIdentityResolver,
  observationCacheEngineIdentity,
} from "../../src/checks/engine-identity.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";

describe("managed check cache metadata", () => {
  it("records complete snapshot and incomplete installed-dependency inputs", () => {
    expect(
      Object.fromEntries(
        Object.entries(CHECK_METADATA).map(([checkId, metadata]) => [
          checkId,
          metadata.observationInputs,
        ]),
      ),
    ).toEqual({
      formatting: "disabled",
      lint: "installed-dependencies",
      types: "installed-dependencies",
      cyclomaticComplexity: "snapshot-only",
      readabilityComplexity: "snapshot-only",
      structuralSecurity: "snapshot-only",
      secrets: "disabled",
      duplication: "snapshot-only",
      dependencyArchitecture: "snapshot-only",
      deadCode: "installed-dependencies",
      reactCorrectness: "snapshot-only",
      reactAccessibility: "snapshot-only",
      vulnerabilities: "disabled",
    });
    expect(isCacheableObservationCheck("types")).toBe(false);
    expect(isCacheableObservationCheck("lint")).toBe(false);
    expect(isCacheableObservationCheck("deadCode")).toBe(false);
    expect(isCacheableObservationCheck("not-a-managed-check")).toBe(false);
    expect(isCacheableObservationCheck("cyclomaticComplexity")).toBe(true);
  });

  it("derives engine versions through installed package metadata", () => {
    const versions = new Map([
      ["eslint", "101.2.3"],
      ["typescript-eslint", "102.3.4"],
      ["typescript", "103.4.5"],
    ]);
    const identity = createObservationCacheEngineIdentityResolver((name) =>
      versions.get(name),
    )("cyclomaticComplexity");

    expect(identity).toBe(
      "eslint@101.2.3+typescript-eslint@102.3.4+typescript@103.4.5+complexity-v2",
    );
    expect(observationCacheEngineIdentity("cyclomaticComplexity")).toMatch(
      /^eslint@\d+\.\d+\.\d+[^+]*\+typescript-eslint@\d+\.\d+\.\d+[^+]*\+typescript@\d+\.\d+\.\d+[^+]*\+complexity-v2$/u,
    );
  });

  it("versions both repaired complexity identities and TypeScript structural parsing", () => {
    const versions = new Map([
      ["eslint", "101.2.3"],
      ["typescript-eslint", "102.3.4"],
      ["typescript", "103.4.5"],
      ["@ast-grep/napi", "104.5.6"],
    ]);
    const identity = createObservationCacheEngineIdentityResolver((name) =>
      versions.get(name),
    );

    expect(identity("readabilityComplexity")).toBe(
      "eslint@101.2.3+typescript-eslint@102.3.4+typescript@103.4.5+zedbee-readability-v2",
    );
    expect(identity("structuralSecurity")).toBe(
      "@ast-grep/napi@104.5.6+typescript@103.4.5+zedbee-structural-rules-v2",
    );
  });

  it("includes the TypeScript tokenizer in duplication identity", () => {
    const versions = new Map([
      ["jscpd", "201.2.3"],
      ["typescript", "202.3.4"],
    ]);

    expect(
      createObservationCacheEngineIdentityResolver((name) =>
        versions.get(name),
      )("duplication"),
    ).toBe(
      "jscpd@201.2.3+typescript@202.3.4+zedbee-clone-normalization-v2",
    );
  });

  it("resolves installed identities for every snapshot-only check", () => {
    const snapshotOnly = Object.values(CHECK_METADATA)
      .filter(({ observationInputs }) => observationInputs === "snapshot-only")
      .map(({ id }) => id);

    expect(
      Object.fromEntries(
        snapshotOnly.map((checkId) => [
          checkId,
          observationCacheEngineIdentity(checkId),
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        snapshotOnly.map((checkId) => [checkId, expect.any(String)]),
      ),
    );
  });

  it("disables caching when any installed engine identity is unavailable", () => {
    const identity = createObservationCacheEngineIdentityResolver((name) =>
      name === "eslint" ? undefined : "1.0.0",
    );

    expect(identity("cyclomaticComplexity")).toBeUndefined();
    expect(identity("types")).toBeUndefined();
    expect(identity("unknown-check")).toBeUndefined();
  });

  it.each([
    { checkId: "lint", expectedCollections: 2 },
    { checkId: "types", expectedCollections: 2 },
    { checkId: "deadCode", expectedCollections: 2 },
    { checkId: "unknown-check", expectedCollections: 0 },
  ])(
    "gates $checkId before custom identities, cache reads, and cache writes",
    async ({ checkId, expectedCollections }) => {
      const fixture = await createInspectionFixture();
      await fixture.writeJson("package.json", {
        name: "fixture",
        private: true,
      });
      await fixture.write("src/value.ts", "export const value = 1;\n");
      const config = resolveConfig({
        schemaVersion: 1,
        profile: "recommended",
        checks: {
          lint: { severity: "error" },
          types: { severity: "error" },
          deadCode: { severity: "error" },
        },
      });
      const inspection = {
        snapshotRoot: fixture.root,
        packageManager: "npm" as const,
        lockfiles: [],
        workspaces: [
          {
            relativeRoot: ".",
            manifestPath: "package.json",
            sourceFiles: ["src/value.ts"],
            tsconfigPaths: [],
            environments: ["typescript" as const],
            dependencyDeclarations: [],
          },
        ],
      };
      let collections = 0;
      const adapter: CheckAdapter = {
        id: checkId,
        output: "observations",
        inspect: async () => ({
          applies: true,
          executionClass: "lightweight",
          requiresBaseline: false,
          targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
        }),
        collect: async (context) => {
          collections += 1;
          return {
            checkId,
            target: context.target,
            baselineObservations: [],
            targetObservations: [],
          };
        },
      };
      const values = new Map<string, CheckObservationSet>();
      const cache = {
        get: vi.fn(async (key: string) => values.get(key)),
        set: vi.fn(async (key: string, value: CheckObservationSet) => {
          values.set(key, value);
        }),
      };
      const cacheEngineIdentity = vi.fn(() => "custom@1.0.0");
      const context = {
        repositoryRoot: fixture.root,
        changeSet: {
          files: new Map([
            [
              "src/value.ts",
              {
                path: "src/value.ts",
                status: "modified" as const,
                addedRanges: [{ start: 1, end: 1 }],
              },
            ],
          ]),
          isEmpty: false,
          containsAddedLine: () => true,
        },
        config,
        snapshots: {
          baselineDir: fixture.root,
          targetDir: fixture.root,
          baselineRef: "HEAD" as const,
          targetRef: "index" as const,
          unsupportedEntries: [],
        },
        baselineInspection: inspection,
        targetInspection: inspection,
        signal: new AbortController().signal,
        policyForFile: testFilePolicyResolver(config),
      };

      await dispatchChecks([adapter], context, {
        cache,
        cacheEngineIdentity,
      });
      await dispatchChecks([adapter], context, {
        cache,
        cacheEngineIdentity,
      });

      expect(collections).toBe(expectedCollections);
      expect(cacheEngineIdentity).not.toHaveBeenCalled();
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    },
  );
});
