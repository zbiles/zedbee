import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ObservationCache } from "../../src/cache/store.js";
import type { CheckAdapter } from "../../src/checks/adapter.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { readStagedChangeSet } from "../../src/git/change-set.js";
import { GitClient } from "../../src/git/client.js";
import { buildSnapshotPair } from "../../src/git/snapshot.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import {
  runScan,
  type RunScanDependencies,
  type RunScanOptions,
} from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

function stableReport(report: Awaited<ReturnType<typeof runScan>>) {
  return {
    ...report,
    startedAt: "<time>",
    durationMs: 0,
    checks: report.checks.map((check) => ({ ...check, durationMs: 0 })),
  };
}

describe("observation cache integration", () => {
  it("reuses staged observation sets while ignoring later unstaged edits", async () => {
    const repository = await createGitRepository();
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.commitAll("baseline");
    await repository.write("src/value.ts", "export const value = 2;\n");
    await repository.git(["add", "--", "src/value.ts"]);

    let collections = 0;
    const adapter = {
      id: "lint",
      output: "observations",
      inspect: async () => ({
        applies: true as const,
        executionClass: "project-analysis" as const,
        requiresBaseline: true,
        targets: [{ id: ".", kind: "repository" as const, relativeRoot: "." }],
      }),
      collect: async (context) => {
        collections += 1;
        return {
          checkId: "lint",
          target: context.target,
          baselineObservations: [],
          targetObservations: [
            {
              check: "lint",
              rule: "fixture-rule",
              identity: "fixture:src/value.ts:1",
              severity: "error" as const,
              message: "Fixture finding.",
              location: { file: "src/value.ts", startLine: 1, endLine: 1 },
            },
          ],
        };
      },
    } satisfies CheckAdapter;
    const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
    const git = new GitClient(repository.root);
    let tick = 0;
    const dependencies: RunScanDependencies = {
      loadConfig: async () => config,
      createGitClient: () => git,
      readChangeSet: readStagedChangeSet,
      buildSnapshots: buildSnapshotPair,
      inspectRepository,
      baselineForEmptyChange: async () => "HEAD",
      dispatch: dispatchChecks,
      evaluate: evaluatePolicy,
      adapters: [adapter],
      now: () => new Date("2026-08-16T00:00:00.000Z"),
      clock: () => tick++,
    };
    const cacheRoot = await mkdtemp(join(tmpdir(), "zedbee-cache-e2e-"));
    onTestFinished(() => rm(cacheRoot, { recursive: true, force: true }));
    const cache = new ObservationCacheStore({ root: cacheRoot });
    const options = {
      repositoryRoot: repository.root,
      dependencies,
      cache,
    } satisfies RunScanOptions;

    const uncached = await runScan(options);
    await repository.write(
      "src/value.ts",
      "export const value = 2;\nexport const unstaged = 3;\n",
    );
    const cached = await runScan(options);

    expect(collections).toBe(1);
    expect(stableReport(cached)).toEqual(stableReport(uncached));

    await repository.git(["add", "--", "src/value.ts"]);
    await runScan(options);
    expect(collections).toBe(2);
  });

  it("continues with full analysis when cache reads and writes fail", async () => {
    const repository = await createGitRepository();
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.commitAll("baseline");
    await repository.write("src/value.ts", "export const value = 2;\n");
    await repository.git(["add", "--", "src/value.ts"]);
    let collections = 0;
    const adapter = {
      id: "lint",
      output: "observations",
      inspect: async () => ({
        applies: true as const,
        executionClass: "project-analysis" as const,
        requiresBaseline: false,
        targets: [{ id: ".", kind: "repository" as const, relativeRoot: "." }],
      }),
      collect: async (context) => {
        collections += 1;
        return {
          checkId: "lint",
          target: context.target,
          baselineObservations: [],
          targetObservations: [],
        };
      },
    } satisfies CheckAdapter;
    const failingCache: ObservationCache = {
      get: async () => {
        throw new Error("read failed");
      },
      set: async () => {
        throw new Error("write failed");
      },
    };
    const git = new GitClient(repository.root);

    const report = await runScan({
      repositoryRoot: repository.root,
      cache: failingCache,
      dependencies: {
        loadConfig: async () =>
          resolveConfig({ schemaVersion: 1, profile: "recommended" }),
        createGitClient: () => git,
        readChangeSet: readStagedChangeSet,
        buildSnapshots: buildSnapshotPair,
        inspectRepository,
        baselineForEmptyChange: async () => "HEAD",
        dispatch: dispatchChecks,
        evaluate: evaluatePolicy,
        adapters: [adapter],
        now: () => new Date("2026-08-16T00:00:00.000Z"),
        clock: () => 0,
      },
    });

    expect(collections).toBe(1);
    expect(report.outcome).toBe("pass");
  });

  it("misses for changed matching behavior and reuses equivalent reordered behavior", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "package.json",
      `${JSON.stringify({ name: "cache-policy-fixture" })}\n`,
    );
    await repository.write("src/value.ts", "console.log('baseline');\n");
    await repository.commitAll("baseline");
    await repository.write("src/value.ts", "console.log('target');\n");
    await repository.git(["add", "--", "src/value.ts"]);
    let collections = 0;
    const adapter = {
      id: "lint",
      output: "observations",
      inspect: async () => ({
        applies: true as const,
        executionClass: "project-analysis" as const,
        requiresBaseline: false,
        targets: [{ id: ".", kind: "repository" as const, relativeRoot: "." }],
      }),
      collect: async (context) => {
        collections += 1;
        return {
          checkId: "lint",
          target: context.target,
          baselineObservations: [],
          targetObservations: [],
        };
      },
    } satisfies CheckAdapter;
    let currentConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: { rules: { "no-console": "warn" } } },
    });
    const git = new GitClient(repository.root);
    const dependencies: RunScanDependencies = {
      loadConfig: async () => currentConfig,
      createGitClient: () => git,
      readChangeSet: readStagedChangeSet,
      buildSnapshots: buildSnapshotPair,
      inspectRepository,
      baselineForEmptyChange: async () => "HEAD",
      dispatch: dispatchChecks,
      evaluate: evaluatePolicy,
      adapters: [adapter],
      now: () => new Date("2026-08-16T00:00:00.000Z"),
      clock: () => 0,
    };
    const cacheRoot = await mkdtemp(join(tmpdir(), "zedbee-cache-policy-"));
    onTestFinished(() => rm(cacheRoot, { recursive: true, force: true }));
    const store = new ObservationCacheStore({ root: cacheRoot });
    const keys: string[] = [];
    const cache: ObservationCache = {
      get: async (key) => {
        keys.push(key);
        return store.get(key);
      },
      set: async (key, observations) => store.set(key, observations),
    };
    const options = {
      repositoryRoot: repository.root,
      dependencies,
      cache,
    } satisfies RunScanOptions;

    await runScan(options);
    currentConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: { rules: { "no-console": "warn" } } },
      overrides: [
        {
          files: ["src/**"],
          checks: {
            lint: { rules: { "no-console": "error", eqeqeq: "warn" } },
          },
        },
      ],
    });
    await runScan(options);
    currentConfig = resolveConfig(
      {
        schemaVersion: 1,
        profile: "recommended",
        checks: { lint: { rules: { "no-console": "warn" } } },
        overrides: [
          {
            files: ["src/**"],
            checks: {
              lint: { rules: { eqeqeq: "warn", "no-console": "error" } },
            },
          },
        ],
      },
      "/different/presentation-only-config.jsonc",
    );
    await runScan(options);

    expect(keys).toHaveLength(3);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
    expect(collections).toBe(2);
  });
});
