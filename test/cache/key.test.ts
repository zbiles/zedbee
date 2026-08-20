import { describe, expect, it } from "vitest";
import { observationCacheEngineIdentity } from "../../src/cache/key.js";
import type { ObservationCache } from "../../src/cache/store.js";
import type {
  CheckAdapter,
  CheckRunContext,
} from "../../src/checks/adapter.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
import { createInspectionFixture } from "../inspection/fixture.js";

function contextFor(snapshotRoot: string, specifier: string): CheckRunContext {
  const config = resolveConfig({ schemaVersion: 1, profile: "fast" });
  const inspection: RepositoryInspection = {
    snapshotRoot,
    packageManager: "npm",
    lockfiles: [],
    workspaces: [
      {
        relativeRoot: ".",
        manifestPath: "package.json",
        sourceFiles: [],
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
});
