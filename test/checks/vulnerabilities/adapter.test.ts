import { describe, expect, it } from "vitest";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { CheckIncompleteError } from "../../../src/checks/incomplete-error.js";
import { createVulnerabilitiesAdapter } from "../../../src/checks/vulnerabilities/adapter.js";
import type { DependencyRecord } from "../../../src/checks/vulnerabilities/inventory/types.js";
import { LockfileInventoryError } from "../../../src/checks/vulnerabilities/inventory/errors.js";
import { OsvUnavailableError } from "../../../src/checks/vulnerabilities/osv/errors.js";
import { osvQueryKey } from "../../../src/checks/vulnerabilities/osv/client.js";
import type { OsvAdvisory, OsvPackageQuery } from "../../../src/checks/vulnerabilities/osv/types.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

function dependency(name: string, version: string, line: number): DependencyRecord {
  return Object.freeze({
    name,
    version,
    ecosystem: "npm",
    lockfilePath: "package-lock.json",
    line,
    importer: ".",
    dependencyPath: Object.freeze([name]),
  });
}

function advisory(id: string, name: string): OsvAdvisory {
  return Object.freeze({
    id,
    aliases: Object.freeze([]),
    affected: Object.freeze([
      Object.freeze({
        package: Object.freeze({ name, ecosystem: "npm" }),
        ranges: Object.freeze([
          Object.freeze({
            type: "SEMVER",
            events: Object.freeze([
              Object.freeze({ introduced: "0" }),
              Object.freeze({ fixed: "9.0.0" }),
            ]),
          }),
        ]),
        versions: Object.freeze([]),
      }),
    ]),
    severity: Object.freeze([Object.freeze({ type: "CVSS_V3", score: "9.1" })]),
    references: Object.freeze([]),
  });
}

async function context(options: {
  changed?: boolean;
  when?: "relevant" | "always";
  onUnavailable?: "block" | "warn";
} = {}): Promise<CheckRunContext> {
  const [baseline, target, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, target, live]) {
    await fixture.writeJson("package.json", { name: "fixture" });
    await fixture.writeJson("package-lock.json", {
      lockfileVersion: 3,
      packages: {},
    });
  }
  const changed = options.changed ?? true;
  const changeSet: ChangeSet = {
    files: new Map([
      [
        changed ? "package-lock.json" : "src/index.ts",
        {
          path: changed ? "package-lock.json" : "src/index.ts",
          status: "modified",
          addedRanges: [{ start: 1, end: 1 }],
        },
      ],
    ]),
    isEmpty: false,
    containsAddedLine: () => true,
  };
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "thorough",
    checks: {
      vulnerabilities: {
        severity: "error",
        when: options.when ?? "relevant",
        onUnavailable: options.onUnavailable ?? "block",
      },
    },
  });
  return {
    repositoryRoot: live.root,
    changeSet,
    config,
    snapshots: {
      baselineDir: baseline.root,
      targetDir: target.root,
      baselineRef: "HEAD",
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(baseline.root),
    targetInspection: await inspectRepository(target.root),
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: config.checks.vulnerabilities,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

describe("vulnerabilitiesAdapter", () => {
  it("skips unchanged dependency state unless configured to run always", async () => {
    const adapter = createVulnerabilitiesAdapter({
      parseInventory: async () => [],
      client: { query: async () => new Map(), probe: async () => undefined },
    });
    await expect(adapter.inspect(await context({ changed: false }))).resolves.toEqual({
      applies: false,
      reason: "No staged dependency state changes",
    });
    await expect(
      adapter.inspect(await context({ changed: false, when: "always" })),
    ).resolves.toMatchObject({ applies: true });
  });

  it("discloses only OSV package metadata and queries the snapshot union once", async () => {
    const run = await context();
    const before = dependency("alpha", "1.0.0", 3);
    const after = [dependency("alpha", "1.0.0", 3), dependency("beta", "2.0.0", 8)];
    const calls: OsvPackageQuery[][] = [];
    const adapter = createVulnerabilitiesAdapter({
      parseInventory: async (inspection) =>
        inspection.snapshotRoot === run.baselineInspection.snapshotRoot ? [before] : after,
      client: {
        async query(packages) {
          calls.push([...packages]);
          return new Map([
            [osvQueryKey(before), [advisory("GHSA-alpha", "alpha")]],
            [osvQueryKey(after[1]!), [advisory("GHSA-beta", "beta")]],
          ]);
        },
        probe: async () => undefined,
      },
    });

    await expect(adapter.inspect(run)).resolves.toMatchObject({
      applies: true,
      executionClass: "network",
      networkDisclosure: {
        services: ["api.osv.dev"],
        metadata: ["package names", "exact versions", "ecosystem identifiers"],
      },
    });
    const result = await adapter.collect(run);
    expect(calls).toEqual([
      [
        { name: "alpha", version: "1.0.0", ecosystem: "npm" },
        { name: "beta", version: "2.0.0", ecosystem: "npm" },
      ],
    ]);
    expect(result.baselineObservations).toHaveLength(1);
    expect(result.targetObservations).toHaveLength(2);
    expect(result.targetObservations[1]).toMatchObject({
      rule: "GHSA-beta",
      location: { file: "package-lock.json", startLine: 8 },
    });
  });

  it("applies onUnavailable only to known OSV availability failures", async () => {
    const run = await context({ onUnavailable: "warn" });
    const unavailable = createVulnerabilitiesAdapter({
      parseInventory: async () => [dependency("alpha", "1.0.0", 3)],
      client: {
        query: async () => {
          throw new OsvUnavailableError("OSV_REQUEST_TIMEOUT", "safe timeout");
        },
        probe: async () => undefined,
      },
    });
    const error = await unavailable.collect(run).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CheckIncompleteError);
    expect(error).toMatchObject({
      code: "OSV_REQUEST_TIMEOUT",
      disposition: "warn",
    });

    const invalid = createVulnerabilitiesAdapter({
      parseInventory: async () => {
        throw new LockfileInventoryError(
          "LOCKFILE_INVALID",
          "The lockfile is invalid.",
        );
      },
      client: { query: async () => new Map(), probe: async () => undefined },
    });
    const parseError = await invalid.collect(run).catch((caught: unknown) => caught);
    expect(parseError).toBeInstanceOf(CheckIncompleteError);
    expect((parseError as CheckIncompleteError).disposition).toBeUndefined();
  });

  it("preserves actionable bun.lockb migration remediation without absolute paths", async () => {
    const run = await context();
    const adapter = createVulnerabilitiesAdapter({
      parseInventory: async () => {
        throw new LockfileInventoryError(
          "LOCKFILE_UNSUPPORTED_BINARY",
          "Bun's legacy binary lockfile cannot be analyzed safely.",
          "Run bun install --save-text-lockfile --frozen-lockfile --lockfile-only, then remove bun.lockb.",
        );
      },
      client: { query: async () => new Map(), probe: async () => undefined },
    });
    const error = await adapter.collect(run).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      remediation:
        "Run bun install --save-text-lockfile --frozen-lockfile --lockfile-only, then remove bun.lockb.",
    });
    expect(JSON.stringify(error)).not.toContain(run.snapshots.targetDir);
  });
});
