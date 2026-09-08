import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ObservationCache } from "../../src/cache/store.js";
import type { CheckAdapter } from "../../src/checks/adapter.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import { loadConfigFromCommit } from "../../src/config/load-config.js";
import { resolveConfig } from "../../src/config/profiles.js";
import {
  readCommitChangeSet,
  readStagedChangeSet,
} from "../../src/git/change-set.js";
import { resolveBaseComparison } from "../../src/git/base-comparison.js";
import { GitClient } from "../../src/git/client.js";
import {
  buildCommitSnapshotPair,
  buildSnapshotPair,
} from "../../src/git/snapshot.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import {
  runScan,
  type RunScanDependencies,
  type RunScanOptions,
} from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { DEFAULT_ANALYSIS_SESSION_DEPENDENCIES } from "../../src/scan/analysis-session.js";
import { DEFAULT_CHECK_ADAPTERS } from "../../src/checks/descriptors.js";

function stableReport(report: Awaited<ReturnType<typeof runScan>>) {
  return {
    ...report,
    startedAt: "<time>",
    durationMs: 0,
    checks: report.checks.map((check) => ({ ...check, durationMs: 0 })),
  };
}

describe("observation cache integration", () => {
  it("rebinds real lint/types captures across owned scan snapshots and rejects corrupt manifests", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "package.json",
      '{"name":"captured-cache","type":"module","dependencies":{"installed":"1.0.0"}}\n',
    );
    await repository.write(".gitignore", "node_modules/\n");
    await repository.write(
      "tsconfig.json",
      '{"compilerOptions":{"strict":true},"include":["src/**/*.ts"]}\n',
    );
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.commitAll("baseline");
    await repository.write(
      "src/value.ts",
      'import { supplied } from "installed";\nexport const value: number = supplied;\n',
    );
    await repository.git(["add", "src/value.ts"]);
    await repository.write(
      "node_modules/installed/package.json",
      '{"name":"installed","type":"module","types":"index.d.ts"}\n',
    );
    await repository.write(
      "node_modules/installed/index.d.ts",
      "export const supplied: number;\n",
    );
    const root = await mkdtemp(join(tmpdir(), "zedbee-real-capture-cache-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const cache = new ObservationCacheStore({ root });
    const dependencies: RunScanDependencies = {
      ...DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
      adapters: DEFAULT_CHECK_ADAPTERS.filter(
        (adapter) => adapter.id === "lint" || adapter.id === "types",
      ),
      evaluate: evaluatePolicy,
      now: () => new Date("2026-09-07T00:00:00Z"),
    };
    const scan = (enabled = true) =>
      runScan({
        repositoryRoot: repository.root,
        dependencies,
        cache: enabled ? cache : false,
      });
    const first = await scan();
    expect(first.summary.incomplete).toBe(0);
    expect(first.outcome).toBe("pass");
    const names = (await readdir(root)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(names).toHaveLength(2);
    const inodes = await Promise.all(
      names.map(async (name) => (await stat(join(root, name))).ino),
    );
    expect(stableReport(await scan())).toEqual(stableReport(first));
    expect(
      await Promise.all(
        names.map(async (name) => (await stat(join(root, name))).ino),
      ),
    ).toEqual(inodes);
    for (const name of names) {
      const path = join(root, name);
      const envelope = JSON.parse(await readFile(path, "utf8"));
      envelope.payload.dependencyInputs.probes = [
        { kind: "missing", path: "repository:../private-secret" },
      ];
      envelope.integrity = createHash("sha256")
        .update(JSON.stringify(envelope.payload))
        .digest("hex");
      await writeFile(path, JSON.stringify(envelope));
    }
    expect(stableReport(await scan())).toEqual(stableReport(await scan(false)));
    await repository.write(
      "node_modules/installed/package.json",
      "{malformed\n",
    );
    expect(stableReport(await scan())).toEqual(stableReport(await scan(false)));
    await repository.write(
      "node_modules/installed/package.json",
      '{"name":"installed","type":"module","types":"index.d.ts"}\n',
    );
    for (const type of ["any", "string", "number"]) {
      await repository.write(
        "node_modules/installed/index.d.ts",
        `export const supplied: ${type};\n`,
      );
      const cached = await scan();
      expect(cached.summary.incomplete).toBe(0);
      expect(stableReport(cached)).toEqual(stableReport(await scan(false)));
      expect(cached.outcome).toBe(type === "number" ? "pass" : "blocked");
    }
  });

  it("reuses staged observation sets while ignoring later unstaged edits", async () => {
    const repository = await createGitRepository();
    await repository.write("package.json", '{"name":"cache-fixture"}\n');
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.commitAll("baseline");
    await repository.write("src/value.ts", "export const value = 2;\n");
    await repository.git(["add", "--", "src/value.ts"]);

    let collections = 0;
    const adapter = {
      id: "reactCorrectness",
      output: "observations",
      inspect: async () => ({
        applies: true as const,
        executionClass: "lightweight" as const,
        requiresBaseline: true,
        targets: [{ id: ".", kind: "repository" as const, relativeRoot: "." }],
      }),
      collect: async (context) => {
        collections += 1;
        return {
          checkId: "reactCorrectness",
          target: context.target,
          baselineObservations: [],
          targetObservations: [
            {
              check: "reactCorrectness",
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
      resolveBaseComparison,
      loadIndexConfig: async () => config,
      loadCommitConfig: loadConfigFromCommit,
      createGitClient: () => git,
      readIndexChangeSet: readStagedChangeSet,
      readCommitChangeSet,
      buildIndexSnapshots: buildSnapshotPair,
      buildCommitSnapshots: buildCommitSnapshotPair,
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
    await repository.write("package.json", '{"name":"cache-fixture"}\n');
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.commitAll("baseline");
    await repository.write("src/value.ts", "export const value = 2;\n");
    await repository.git(["add", "--", "src/value.ts"]);
    let collections = 0;
    const adapter = {
      id: "reactCorrectness",
      output: "observations",
      inspect: async () => ({
        applies: true as const,
        executionClass: "lightweight" as const,
        requiresBaseline: false,
        targets: [{ id: ".", kind: "repository" as const, relativeRoot: "." }],
      }),
      collect: async (context) => {
        collections += 1;
        return {
          checkId: "reactCorrectness",
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
        resolveBaseComparison,
        loadIndexConfig: async () =>
          resolveConfig({ schemaVersion: 1, profile: "recommended" }),
        loadCommitConfig: loadConfigFromCommit,
        createGitClient: () => git,
        readIndexChangeSet: readStagedChangeSet,
        readCommitChangeSet,
        buildIndexSnapshots: buildSnapshotPair,
        buildCommitSnapshots: buildCommitSnapshotPair,
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
      id: "reactCorrectness",
      output: "observations",
      inspect: async () => ({
        applies: true as const,
        executionClass: "lightweight" as const,
        requiresBaseline: false,
        targets: [{ id: ".", kind: "repository" as const, relativeRoot: "." }],
      }),
      collect: async (context) => {
        collections += 1;
        return {
          checkId: "reactCorrectness",
          target: context.target,
          baselineObservations: [],
          targetObservations: [],
        };
      },
    } satisfies CheckAdapter;
    let currentConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { reactCorrectness: { rules: { "react/no-danger": "warn" } } },
    });
    const git = new GitClient(repository.root);
    const dependencies: RunScanDependencies = {
      resolveBaseComparison,
      loadIndexConfig: async () => currentConfig,
      loadCommitConfig: loadConfigFromCommit,
      createGitClient: () => git,
      readIndexChangeSet: readStagedChangeSet,
      readCommitChangeSet,
      buildIndexSnapshots: buildSnapshotPair,
      buildCommitSnapshots: buildCommitSnapshotPair,
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
      checks: { reactCorrectness: { rules: { "react/no-danger": "warn" } } },
      overrides: [
        {
          files: ["package.json"],
          checks: {
            reactCorrectness: { rules: { "react/no-danger": "error" } },
          },
        },
      ],
    });
    await runScan(options);
    currentConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { reactCorrectness: { rules: { "react/no-danger": "warn" } } },
      overrides: [
        {
          files: ["package.json"],
          checks: {
            reactCorrectness: { rules: { "react/no-danger": "error" } },
          },
        },
        {
          files: ["."],
          checks: { reactCorrectness: { rules: { "react/no-danger": "off" } } },
        },
      ],
    });
    await runScan(options);
    currentConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { reactCorrectness: { rules: { "react/no-danger": "warn" } } },
      overrides: [
        {
          files: ["."],
          checks: { reactCorrectness: { rules: { "react/no-danger": "off" } } },
        },
        {
          files: ["package.json"],
          checks: {
            reactCorrectness: { rules: { "react/no-danger": "error" } },
          },
        },
      ],
    });
    await runScan(options);
    currentConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { reactCorrectness: { rules: { "react/no-danger": "warn" } } },
      overrides: [
        {
          files: ["src/**"],
          checks: {
            reactCorrectness: {
              rules: {
                "react/no-danger": "error",
                "react/no-unknown-property": "warn",
              },
            },
          },
        },
      ],
    });
    await runScan(options);
    currentConfig = resolveConfig(
      {
        schemaVersion: 1,
        profile: "recommended",
        checks: { reactCorrectness: { rules: { "react/no-danger": "warn" } } },
        overrides: [
          {
            files: ["src/**"],
            checks: {
              reactCorrectness: {
                rules: {
                  "react/no-unknown-property": "warn",
                  "react/no-danger": "error",
                },
              },
            },
          },
        ],
      },
      "/different/presentation-only-config.jsonc",
    );
    await runScan(options);

    expect(keys).toHaveLength(6);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(keys[2]);
    expect(keys[0]).toBe(keys[3]);
    expect(keys[3]).not.toBe(keys[4]);
    expect(keys[4]).toBe(keys[5]);
    expect(collections).toBe(2);
  });
});
