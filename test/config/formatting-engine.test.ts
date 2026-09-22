import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/profiles.js";
import { configFileSchema } from "../../src/config/schema.js";
import {
  managedPolicyScalarKeys,
  snapshotManagedPolicy,
} from "../../src/config/settings-registry.js";
import {
  restoreCheckContext,
  serializeCheckContext,
} from "../../src/checks/runner/context.js";
import type { CheckRunContext } from "../../src/checks/adapter.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import type { SnapshotPair } from "../../src/git/snapshot.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";

function emptyInspection(snapshotRoot: string): RepositoryInspection {
  return {
    snapshotRoot,
    packageManager: "npm",
    lockfiles: [],
    workspaces: [],
  };
}

function createContext(config: ReturnType<typeof resolveConfig>): CheckRunContext {
  const changeSet: ChangeSet = {
    files: new Map(),
    isEmpty: true,
    containsAddedLine: () => false,
  };
  const snapshots: SnapshotPair = {
    baselineDir: "/tmp/baseline",
    targetDir: "/tmp/target",
    baselineRef: "HEAD",
    targetRef: "index",
    unsupportedEntries: [],
    cleanup: async () => undefined,
  };
  return {
    repositoryRoot: "/repo",
    changeSet,
    config,
    snapshots,
    baselineInspection: emptyInspection(snapshots.baselineDir),
    targetInspection: emptyInspection(snapshots.targetDir),
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: config.checks.formatting,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

describe("formatting engine policy", () => {
  it("defaults omitted engine to managed without changing other fields", () => {
    expect(resolveConfig(undefined).checks.formatting.engine).toBe("managed");
    expect(
      resolveConfig({
        schemaVersion: 1,
        checks: { formatting: "warn" },
      }).checks.formatting.engine,
    ).toBe("managed");
  });

  it("resolves an explicit project engine", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      checks: { formatting: { engine: "project" } },
    });

    expect(config.checks.formatting.engine).toBe("project");
  });

  it("registers the engine as an effective scalar setting", () => {
    expect(managedPolicyScalarKeys("formatting")).toContain("engine");
  });

  it("rejects unknown engine values", () => {
    expect(
      configFileSchema.safeParse({
        schemaVersion: 1,
        checks: { formatting: { engine: "sandbox" } },
      }).success,
    ).toBe(false);
  });

  it("rejects project engine combined with managed settings in one object", () => {
    expect(
      configFileSchema.safeParse({
        schemaVersion: 1,
        checks: {
          formatting: { engine: "project", settings: { printWidth: 100 } },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects an override selecting project engine while managed settings are inherited", () => {
    expect(() =>
      resolveConfig({
        schemaVersion: 1,
        checks: { formatting: { settings: { printWidth: 100 } } },
        overrides: [
          {
            files: ["packages/**"],
            checks: { formatting: { engine: "project" } },
          },
        ],
      }),
    ).toThrow(/project/u);
  });

  it("rejects an override adding managed settings when the root selects project engine", () => {
    expect(() =>
      resolveConfig({
        schemaVersion: 1,
        checks: { formatting: { engine: "project" } },
        overrides: [
          {
            files: ["packages/**"],
            checks: { formatting: { settings: { printWidth: 100 } } },
          },
        ],
      }),
    ).toThrow(/project/u);
  });

  it("allows file overrides to select project engine without managed settings", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      checks: { formatting: { engine: "managed" } },
      overrides: [
        {
          files: ["packages/web/**"],
          checks: { formatting: { engine: "project" } },
        },
      ],
    });

    expect(config.overrides[0]?.checks.formatting?.engine).toBe("project");
    expect(config.checks.formatting.engine).toBe("managed");
  });

  it("allows a project default to switch to managed settings in one file scope", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      checks: { formatting: { engine: "project" } },
      overrides: [
        {
          files: ["docs/**"],
          checks: {
            formatting: {
              engine: "managed",
              settings: { printWidth: 100 },
            },
          },
        },
      ],
    });

    expect(config.overrides[0]?.checks.formatting).toMatchObject({
      engine: "managed",
      settings: { printWidth: 100 },
    });
  });

  it("survives the dispatcher immutable policy snapshot", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      checks: { formatting: { engine: "project" } },
    });

    const snapshot = snapshotManagedPolicy(
      "formatting",
      config.checks.formatting,
    );

    expect(snapshot.engine).toBe("project");
  });

  it("survives worker serialization and restore", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      checks: { formatting: { engine: "project" } },
    });
    const context = createContext(config);

    const serialized = JSON.parse(
      JSON.stringify(serializeCheckContext(context)),
    ) as ReturnType<typeof serializeCheckContext>;
    const restored = restoreCheckContext(
      serialized,
      new AbortController().signal,
    );

    expect(restored.config.checks.formatting.engine).toBe("project");
  });

  it("rejects a project engine selected by one override when a later matching override adds managed settings", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      overrides: [
        {
          files: ["packages/web/**"],
          checks: { formatting: { engine: "project" } },
        },
        {
          files: ["packages/**"],
          checks: { formatting: { settings: { printWidth: 100 } } },
        },
      ],
    });

    expect(() =>
      testFilePolicyResolver(config)(
        "formatting",
        "packages/web/value.ts",
        "target",
      ),
    ).toThrow(/project/u);
  });

  it("rejects managed settings added by an earlier matching override that later selects the project engine", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      overrides: [
        {
          files: ["packages/**"],
          checks: { formatting: { settings: { printWidth: 100 } } },
        },
        {
          files: ["packages/web/**"],
          checks: { formatting: { engine: "project" } },
        },
      ],
    });

    expect(() =>
      testFilePolicyResolver(config)(
        "formatting",
        "packages/web/value.ts",
        "target",
      ),
    ).toThrow(/project/u);
  });

  it("allows ordered overrides that never combine the project engine with managed settings", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      overrides: [
        {
          files: ["packages/web/**"],
          checks: { formatting: { engine: "managed" } },
        },
        {
          files: ["packages/**"],
          checks: { formatting: { settings: { printWidth: 100 } } },
        },
      ],
    });

    const policy = testFilePolicyResolver(config)(
      "formatting",
      "packages/web/value.ts",
      "target",
    );

    expect(policy.engine).toBe("managed");
    expect(policy.settings.printWidth).toBe(100);
  });
});
