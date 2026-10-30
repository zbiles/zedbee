import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { CheckAdapter } from "../../src/checks/adapter.js";
import type { dispatchChecks } from "../../src/checks/dispatcher.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import {
  buildFixPlan,
  type BuildFixPlanDependencies,
} from "../../src/fixes/build-plan.js";
import { runScan } from "../../src/scan/run-scan.js";
import {
  withAnalysisSession,
  DEFAULT_ANALYSIS_SESSION_DEPENDENCIES as defaults,
  type AnalysisSessionDependencies,
} from "../../src/scan/analysis-session.js";
import { createGitRepository } from "../helpers/git-repository.js";
import {
  createLocalAnalyzerExecutor,
  type AnalyzerExecutor,
} from "../../src/checks/runner/executor.js";
import { activeAnalyzerExecutionSession } from "../../src/checks/runner/session.js";
import type { ScanEvent } from "../../src/checks/events.js";

const configuration = {
  schemaVersion: 1,
  profile: "fast",
  checks: {
    formatting: "off",
    lint: "error",
    cyclomaticComplexity: "off",
    readabilityComplexity: "off",
    structuralSecurity: "off",
    reactCorrectness: "off",
    reactAccessibility: "off",
  },
  pathExclusions: [
    { files: ["excluded.ts"], checks: ["lint"], reason: "Generated fixture" },
  ],
};

async function repositoryFixture() {
  const repository = await createGitRepository("zedbee-analysis-session-");
  await repository.write("package.json", '{"name":"fixture","private":true}\n');
  await repository.write(".zedbeerc.jsonc", JSON.stringify(configuration));
  await repository.write("value.ts", "export const value = 1;\n");
  await repository.commitAll("baseline");
  await repository.write("value.ts", "export const value = 2;\n");
  await repository.git(["add", "--", "value.ts"]);
  return repository;
}

function fixDependencies(
  dependencies: AnalysisSessionDependencies,
): BuildFixPlanDependencies {
  return {
    captureIndexComparison: dependencies.captureIndexComparison,
    loadConfig: dependencies.loadIndexConfig,
    createGitClient: dependencies.createGitClient,
    readChangeSet: dependencies.readIndexChangeSet,
    discoverChangeSet: dependencies.discoverIndexChangeSet,
    addLineRanges: dependencies.addIndexLineRanges,
    buildSnapshots: dependencies.buildIndexSnapshots,
    inspectRepository: dependencies.inspectRepository,
    dispatch: dependencies.dispatch,
    adapters: dependencies.adapters,
    evaluate: evaluatePolicy,
    hasUnstagedChanges: async () => false,
  };
}

const consumers = ["scan", "fix"] as const;
async function analyze(
  consumer: (typeof consumers)[number],
  root: string,
  dependencies: AnalysisSessionDependencies,
  signal?: AbortSignal,
) {
  const options = {
    repositoryRoot: root,
    ...(signal === undefined ? {} : { signal }),
  };
  if (consumer === "scan") {
    return runScan({
      ...options,
      cache: false,
      dependencies: {
        ...dependencies,
        evaluate: evaluatePolicy,
        now: () => new Date(),
      },
    });
  }
  return buildFixPlan({
    ...options,
    selectedChecks: ["lint"],
    dependencies: fixDependencies(dependencies),
  });
}

describe("shared analysis session", () => {
  it("does not strand a handed-off selection if report clock setup fails", async () => {
    const repo = await repositoryFixture();
    let captures = 0;
    let cleanups = 0;
    let now = 0;
    await expect(
      runScan({
        repositoryRoot: repo.root,
        merge: "auto",
        mergeEnvironment: {},
        cache: false,
        dependencies: {
          ...defaults,
          evaluate: evaluatePolicy,
          now() {
            if (++now === 2) throw new Error("clock failed");
            return new Date();
          },
          async captureIndexComparison(...parameters) {
            captures++;
            const selected = await defaults.captureIndexComparison!(
              ...parameters,
            );
            onTestFinished(selected.cleanup);
            return {
              ...selected,
              async cleanup() {
                cleanups++;
                await selected.cleanup();
              },
            };
          },
        },
      }),
    ).rejects.toThrow("clock failed");
    expect(cleanups).toBe(captures);
  });
  it.each([false, true])(
    "hands an auto-merge preflight's selection to analysis once (cleanup fails=%s)",
    async (cleanupFails) => {
      const repo = await repositoryFixture();
      let captures = 0;
      let cleanups = 0;
      const report = await runScan({
        repositoryRoot: repo.root,
        merge: "auto",
        mergeEnvironment: {},
        cache: false,
        dependencies: {
          ...defaults,
          evaluate: evaluatePolicy,
          now: () => new Date(),
          dispatch: async () => [],
          async captureIndexComparison(...parameters) {
            captures++;
            const selected = await defaults.captureIndexComparison!(
              ...parameters,
            );
            return {
              ...selected,
              async cleanup() {
                cleanups++;
                await selected.cleanup();
                if (cleanupFails) throw new Error("private raw cleanup detail");
              },
            };
          },
        },
      });
      expect(report.outcome).toBe(cleanupFails ? "incomplete" : "pass");
      expect(captures).toBe(1);
      expect(cleanups).toBe(1);
      expect(report.changedFileCount).toBe(1);
      if (cleanupFails)
        expect(report.checks.map((check) => check.error?.code)).toEqual([
          "SNAPSHOT_CLEANUP_FAILED",
        ]);
      expect(JSON.stringify(report)).not.toContain(
        "private raw cleanup detail",
      );
    },
  );
  it.each([false, true])(
    "cleans its private index and retains snapshot cleanup diagnosis (index cleanup fails=%s)",
    async (indexCleanupFails) => {
      const repo = await repositoryFixture();
      let selectedCleaned = false;
      const outcome = await withAnalysisSession(
        {
          repositoryRoot: repo.root,
          dependencies: {
            ...defaults,
            async captureIndexComparison(...parameters) {
              const selected = await defaults.captureIndexComparison!(
                ...parameters,
              );
              return {
                ...selected,
                async cleanup() {
                  await selected.cleanup();
                  selectedCleaned = true;
                  if (indexCleanupFails)
                    throw new Error("index cleanup failed");
                },
              };
            },
            async buildIndexSnapshots(...parameters) {
              const pair = await defaults.buildIndexSnapshots(...parameters);
              onTestFinished(pair.cleanup);
              return {
                ...pair,
                async cleanup() {
                  throw new Error("cleanup failed");
                },
              };
            },
            dispatch: async () => [],
          },
        },
        async () => null,
      );
      expect(outcome.cleanupFailure).toBeDefined();
      expect(outcome.cleanupFailure?.temporaryPath).toBeDefined();
      expect(selectedCleaned).toBe(true);
    },
  );
  it.each(["configuration", "metadata", "snapshots"])(
    "keeps one selected comparison when HEAD/index change after %s",
    async (point) => {
      const repo = await repositoryFixture();
      async function mutate() {
        await repo.write(
          "value.ts",
          "export const value = 99;\nexport const later = 1;\n",
        );
        await repo.commitAll("concurrent agent commit");
        await repo.write(
          "value.ts",
          "export const value = 99;\nexport const later = 2;\n",
        );
        await repo.git(["add", "value.ts"]);
      }
      let selected = "";
      const outcome = await withAnalysisSession(
        {
          repositoryRoot: repo.root,
          dependencies: {
            ...defaults,
            async loadIndexConfig(...parameters) {
              const config = await defaults.loadIndexConfig(...parameters);
              if (point === "configuration") await mutate();
              return config;
            },
            async discoverIndexChangeSet(...parameters) {
              const changes = await defaults.discoverIndexChangeSet!(
                ...parameters,
              );
              if (point === "metadata") await mutate();
              return changes;
            },
            async buildIndexSnapshots(...parameters) {
              const pair = await defaults.buildIndexSnapshots(...parameters);
              if (point === "snapshots") await mutate();
              return pair;
            },
            async dispatch(_adapters, context) {
              selected = await readFile(
                join(context.snapshots.targetDir, "value.ts"),
                "utf8",
              );
              expect(
                await readFile(
                  join(context.snapshots.baselineDir, "value.ts"),
                  "utf8",
                ),
              ).toBe("export const value = 1;\n");
              expect(
                context.changeSet.files.get("value.ts")?.addedRanges,
              ).toEqual([{ start: 1, end: 1 }]);
              return [];
            },
          },
        },
        async () => null,
      );
      expect(outcome.completed, JSON.stringify(outcome)).toBe(true);
      expect(selected).toBe("export const value = 2;\n");
    },
  );

  it("announces preparation before awaiting each operation, including source capture and cleanup", async () => {
    const repository = await repositoryFixture();
    const local = createLocalAnalyzerExecutor();
    const order: string[] = [];
    const observed: ScanEvent[] = [];
    let tick = 0;
    try {
      const outcome = await withAnalysisSession(
        {
          repositoryRoot: repository.root,
          onEvent(event) {
            observed.push(event);
            if (event.type === "scan-phase") order.push(event.phase);
          },
          executor: {
            async openSession(options) {
              order.push("capture");
              return local.openSession(options);
            },
            close: () => local.close(),
          },
          dependencies: {
            ...defaults,
            clock: () => tick++,
            async loadIndexConfig(...args) {
              order.push("config");
              return defaults.loadIndexConfig(...args);
            },
            async discoverIndexChangeSet(...args) {
              order.push("discover");
              return defaults.discoverIndexChangeSet!(...args);
            },
            async buildIndexSnapshots(...args) {
              order.push("snapshots");
              const pair = await defaults.buildIndexSnapshots(...args);
              return {
                ...pair,
                async cleanup() {
                  order.push("remove snapshots");
                  await pair.cleanup();
                },
              };
            },
            async addIndexLineRanges(...args) {
              order.push("ranges");
              return defaults.addIndexLineRanges!(...args);
            },
            async inspectRepository(...args) {
              order.push("inspect");
              return defaults.inspectRepository(...args);
            },
            async dispatch() {
              order.push("checks");
              return [];
            },
          },
        },
        async () => {
          order.push("consume");
          return 42;
        },
      );
      expect(outcome.completed).toBe(true);
      expect(order).toEqual([
        "configuration",
        "config",
        "change-discovery",
        "discover",
        "snapshot-construction",
        "snapshots",
        "change-discovery",
        "ranges",
        "project-inspection",
        "inspect",
        "inspect",
        "source-capture",
        "capture",
        "dispatch",
        "checks",
        "policy-evaluation",
        "consume",
        "cleanup",
        "remove snapshots",
      ]);
      expect(observed.map(({ timestamp }) => timestamp)).toEqual(
        observed.map((_, index) => index),
      );
    } finally {
      await local.close();
    }
  });

  it("keeps a failing progress observer from changing the scan outcome or cleanup", async () => {
    const repository = await repositoryFixture();
    let cleaned = false;
    const outcome = await withAnalysisSession(
      {
        repositoryRoot: repository.root,
        onEvent() {
          throw new Error("display unavailable");
        },
        dependencies: {
          ...defaults,
          async buildIndexSnapshots(...args) {
            const pair = await defaults.buildIndexSnapshots(...args);
            return {
              ...pair,
              async cleanup() {
                await pair.cleanup();
                cleaned = true;
              },
            };
          },
          dispatch: async () => [],
        },
      },
      async () => 42,
    );
    expect(outcome).toMatchObject({ completed: true, value: 42 });
    expect(cleaned).toBe(true);
  });

  it.each([false, true])(
    "prepares only after nonempty discovery and before snapshots (snapshot fails: %s)",
    async (fails) => {
      const repository = await repositoryFixture();
      const local = createLocalAnalyzerExecutor();
      const order: string[] = [];
      const executor = {
        prepare() {
          order.push("prepare");
        },
        openSession: async (
          options: Parameters<typeof local.openSession>[0],
        ) => {
          order.push("open");
          return local.openSession(options);
        },
        close: () => local.close(),
      };
      try {
        const outcome = await withAnalysisSession(
          {
            repositoryRoot: repository.root,
            executor,
            dependencies: {
              ...defaults,
              buildIndexSnapshots: async (...args) => {
                order.push("snapshot");
                if (fails) throw new Error("snapshot failed");
                return defaults.buildIndexSnapshots(...args);
              },
              inspectRepository: async (...args) => {
                order.push("inspection");
                return defaults.inspectRepository(...args);
              },
              dispatch: async () => [],
            },
          },
          async () => 42,
        );
        expect(outcome.completed).toBe(!fails);
        expect(order).toEqual(
          fails
            ? ["prepare", "snapshot"]
            : ["prepare", "snapshot", "inspection", "inspection", "open"],
        );
      } finally {
        await local.close();
      }
    },
  );

  it.each([false, true])(
    "retains snapshots only when execution close is unproved (%s)",
    async (failClose) => {
      const repository = await repositoryFixture();
      const local = createLocalAnalyzerExecutor();
      let pair:
        Awaited<ReturnType<typeof defaults.buildIndexSnapshots>> | undefined;
      let release: (() => Promise<void>) | undefined;
      const executor: AnalyzerExecutor = {
        async openSession(options) {
          const session = await local.openSession(options);
          release = () => session.close();
          return {
            run: session.run.bind(session),
            async close() {
              if (failClose) throw new Error("private native cleanup failure");
              await session.close();
            },
          };
        },
        close: () => local.close(),
      };
      try {
        const outcome = await withAnalysisSession(
          {
            repositoryRoot: repository.root,
            executor,
            dependencies: {
              ...defaults,
              buildIndexSnapshots: async (...args) =>
                (pair = await defaults.buildIndexSnapshots(...args)),
              dispatch: async () => [],
            },
          },
          async () => 42,
        );
        expect(outcome.cleanupFailure !== undefined).toBe(failClose);
        expect(JSON.stringify(outcome.cleanupFailure ?? {})).not.toContain(
          "private native",
        );
        if (failClose)
          await expect(access(pair!.targetDir)).resolves.toBeUndefined();
        else await expect(access(pair!.targetDir)).rejects.toThrow();
        // The scan closes only its session: this caller-owned executor is reusable.
        const next = await local.openSession();
        await next.close();
      } finally {
        await release?.();
        await local.close();
        await pair?.cleanup();
      }
    },
  );

  it("scopes each API scan and fix preview to a fresh caller-owned execution session", async () => {
    const repository = await repositoryFixture();
    const executor = createLocalAnalyzerExecutor();
    const sessions = new Set<unknown>();
    const dispatch: typeof dispatchChecks = async () => {
      expect(activeAnalyzerExecutionSession()).toBeDefined();
      sessions.add(activeAnalyzerExecutionSession());
      return [];
    };
    try {
      await runScan({
        repositoryRoot: repository.root,
        executor,
        cache: false,
        dependencies: {
          ...defaults,
          dispatch,
          evaluate: evaluatePolicy,
          now: () => new Date(),
        },
      });
      await buildFixPlan({
        repositoryRoot: repository.root,
        executor,
        dependencies: fixDependencies({ ...defaults, dispatch }),
      });
      expect(sessions.size).toBe(2);
      expect(activeAnalyzerExecutionSession()).toBeUndefined();
      const next = await executor.openSession();
      await next.close();
    } finally {
      await executor.close();
    }
  });
  it.each(consumers)(
    "%s trusts index configuration and passes the same signal through safe preparation",
    async (consumer) => {
      const repository = await repositoryFixture();
      await repository.write(
        ".zedbeerc.jsonc",
        JSON.stringify({
          ...configuration,
          checks: { ...configuration.checks, lint: "off" },
        }),
      );
      const controller = new AbortController();
      const signals: (AbortSignal | undefined)[] = [];
      const order: string[] = [];
      let enabled: string | undefined;
      const dependencies: AnalysisSessionDependencies = {
        ...defaults,
        discoverIndexChangeSet: async (git, signal) => {
          signals.push(signal);
          order.push("discovery");
          return defaults.discoverIndexChangeSet!(git, signal);
        },
        buildIndexSnapshots: async (root, git, signal) => {
          signals.push(signal);
          order.push("snapshot");
          const pair = await defaults.buildIndexSnapshots(root, git, signal);
          return {
            ...pair,
            cleanup: async () => {
              order.push("cleanup");
              await pair.cleanup();
            },
          };
        },
        addIndexLineRanges: async (git, changes, excluded, signal) => {
          signals.push(signal);
          order.push("ranges");
          return defaults.addIndexLineRanges!(git, changes, excluded, signal);
        },
        dispatch: async (_adapters, context) => {
          signals.push(context.signal);
          order.push("dispatch");
          enabled = context.config.checks.lint.severity;
          return [];
        },
      };
      await analyze(consumer, repository.root, dependencies, controller.signal);
      expect(enabled).toBe("error");
      expect(signals).toEqual([
        controller.signal,
        controller.signal,
        controller.signal,
        controller.signal,
      ]);
      expect(order).toEqual([
        "discovery",
        "snapshot",
        "ranges",
        "dispatch",
        "cleanup",
      ]);
    },
  );

  it.each(consumers)(
    "%s excludes unsupported target inputs before diff and restores all text lines after a binary baseline",
    async (consumer) => {
      const repository = await repositoryFixture();
      await repository.write("value.ts", "binary\0baseline");
      await repository.commitAll("binary baseline");
      await repository.write(
        "value.ts",
        "export const first = 1;\nexport const second = 2;\n",
      );
      await repository.write("excluded.ts", "binary\0target");
      await repository.git(["add", "--all"]);
      let ranges: unknown;
      let exclusions: string[] = [];
      await analyze(consumer, repository.root, {
        ...defaults,
        addIndexLineRanges: async (git, changes, excluded, signal) => {
          exclusions = [...excluded!].sort();
          return defaults.addIndexLineRanges!(git, changes, excluded, signal);
        },
        dispatch: async (_adapters, context) => {
          ranges = context.changeSet.files.get("value.ts")?.addedRanges;
          return [];
        },
      });
      expect(exclusions).toEqual(["excluded.ts", "value.ts"]);
      expect(ranges).toEqual([{ start: 1, end: 2 }]);
    },
  );

  // Creating Git entries does not avoid the OS privilege needed when snapshots
  // materialize file symlinks. Keep binary recovery covered on normal Windows.
  it.runIf(process.platform !== "win32").each(consumers)(
    "%s excludes materialized symbolic-link targets before line diff",
    async (consumer) => {
      const repository = await repositoryFixture();
      await repository.write(".link-target", "value.ts");
      const linkBlob = await repository.git([
        "hash-object",
        "-w",
        "--",
        ".link-target",
      ]);
      expect(linkBlob.exitCode).toBe(0);
      const staged = await repository.git([
        "update-index",
        "--add",
        "--cacheinfo",
        "120000",
        linkBlob.stdout.trim(),
        "link.ts",
      ]);
      expect(staged.exitCode).toBe(0);
      let exclusions: string[] = [];
      await analyze(consumer, repository.root, {
        ...defaults,
        addIndexLineRanges: async (git, changes, excluded, signal) => {
          exclusions = [...excluded!].sort();
          return defaults.addIndexLineRanges!(git, changes, excluded, signal);
        },
        dispatch: async () => [],
      });
      expect(exclusions).toEqual(["link.ts"]);
    },
  );

  it.each(consumers)(
    "%s waits for a cancelled analyzer to stop before removing its snapshot",
    async (consumer) => {
      const repository = await repositoryFixture();
      const controller = new AbortController();
      const order: string[] = [];
      let startedResolve!: () => void;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      let stopResolve!: () => void;
      const stop = new Promise<void>((resolve) => {
        stopResolve = resolve;
      });
      const adapter: CheckAdapter = {
        id: "lint",
        output: "observations",
        inspect: async () => ({
          applies: true,
          executionClass: "lightweight",
          requiresBaseline: true,
          targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
        }),
        collect: async (context) => {
          startedResolve();
          await stop;
          await access(context.snapshots.targetDir);
          order.push("worker-stopped");
          context.signal.throwIfAborted();
          return {
            checkId: "lint",
            target: context.target,
            baselineObservations: [],
            targetObservations: [],
          };
        },
      };
      const pending = analyze(
        consumer,
        repository.root,
        {
          ...defaults,
          adapters: [adapter],
          buildIndexSnapshots: async (root, git, signal) => {
            const pair = await defaults.buildIndexSnapshots(root, git, signal);
            return {
              ...pair,
              cleanup: async () => {
                order.push("snapshot-cleaned");
                await pair.cleanup();
              },
            };
          },
        },
        controller.signal,
      );
      await started;
      controller.abort(new Error("cancelled"));
      expect(order).toEqual([]);
      stopResolve();
      await expect(pending).rejects.toThrow("cancelled");
      expect(order).toEqual(["worker-stopped", "snapshot-cleaned"]);
    },
  );

  it("keeps a callback failure and one cleanup diagnosis together", async () => {
    const repository = await repositoryFixture();
    const primary = new Error("private callback detail");
    let cleanups = 0;
    const outcome = await withAnalysisSession(
      {
        repositoryRoot: repository.root,
        dependencies: {
          ...defaults,
          dispatch: async () => [],
          buildIndexSnapshots: async (root, git, signal) => {
            const pair = await defaults.buildIndexSnapshots(root, git, signal);
            return {
              ...pair,
              cleanup: async () => {
                cleanups++;
                await pair.cleanup();
                throw new Error("private cleanup detail");
              },
            };
          },
        },
      },
      async () => {
        throw primary;
      },
    );
    expect(outcome.completed).toBe(false);
    if (outcome.completed) throw new Error("expected callback failure");
    expect(outcome.error).toBe(primary);
    expect(outcome.state.phase).toBe("policy-evaluation");
    expect(outcome.cleanupFailure).toBeDefined();
    expect(JSON.stringify(outcome.cleanupFailure)).not.toContain("private");
    expect(cleanups).toBe(1);
  });

  it.each(consumers)(
    "%s refuses enabled unsupported input before line ranges or dispatch",
    async (consumer) => {
      const repository = await repositoryFixture();
      await repository.write("value.ts", "binary\0target");
      await repository.git(["add", "--", "value.ts"]);
      const order: string[] = [];
      const pending = analyze(consumer, repository.root, {
        ...defaults,
        buildIndexSnapshots: async (root, git, signal) => {
          const pair = await defaults.buildIndexSnapshots(root, git, signal);
          return {
            ...pair,
            cleanup: async () => {
              order.push("cleanup");
              await pair.cleanup();
            },
          };
        },
        addIndexLineRanges: async () => {
          order.push("ranges");
          throw new Error("unexpected ranges");
        },
        dispatch: async () => {
          order.push("dispatch");
          return [];
        },
      });
      if (consumer === "scan") {
        const report = await pending;
        expect(report).toHaveProperty("outcome", "incomplete");
        expect(report).toHaveProperty(
          "checks.0.error.code",
          "UNSUPPORTED_BINARY_INPUT",
        );
      } else {
        await expect(pending).rejects.toThrow("unsupported staged input");
      }
      expect(order).toEqual(["cleanup"]);
    },
  );

  it.each([
    Object.freeze(new Error("private frozen cancellation")),
    "private primitive cancellation",
    new Error("private extensible cancellation"),
  ])(
    "retains cancellation identity or cause with safe cleanup metadata",
    async (reason) => {
      const repository = await repositoryFixture();
      const controller = new AbortController();
      const failure = await analyze(
        "scan",
        repository.root,
        {
          ...defaults,
          dispatch: async () => [],
          buildIndexSnapshots: async (root, git, signal) => {
            const pair = await defaults.buildIndexSnapshots(root, git, signal);
            return {
              ...pair,
              cleanup: async () => {
                await pair.cleanup();
                controller.abort(reason);
                throw new Error("private cleanup detail");
              },
            };
          },
        },
        controller.signal,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (reason instanceof Error && Object.isExtensible(reason)) {
        expect(failure).toBe(reason);
        expect(failure).toHaveProperty(
          "cleanupFailure.primaryFailure.code",
          "POLICY_EVALUATION_FAILED",
        );
        expect(Object.keys(failure as Error)).not.toContain("cleanupFailure");
      } else {
        expect(failure).toHaveProperty("cause", reason);
      }
      expect(JSON.stringify(failure)).not.toContain("private");
    },
  );

  it("reports both dispatch and cleanup failures without raw causes", async () => {
    const repository = await repositoryFixture();
    const report = await runScan({
      repositoryRoot: repository.root,
      cache: false,
      dependencies: {
        ...defaults,
        evaluate: evaluatePolicy,
        now: () => new Date(),
        dispatch: async () => {
          throw new Error("private dispatch detail");
        },
        buildIndexSnapshots: async (root, git, signal) => {
          const pair = await defaults.buildIndexSnapshots(root, git, signal);
          return {
            ...pair,
            cleanup: async () => {
              await pair.cleanup();
              throw new Error("private cleanup detail");
            },
          };
        },
      },
    });
    expect(report.checks.map((check) => check.error?.code)).toEqual([
      "CHECK_DISPATCH_FAILED",
      "SNAPSHOT_CLEANUP_FAILED",
    ]);
    expect(report.exitCode).toBe(2);
    expect(JSON.stringify(report)).not.toContain("private");
  });

  it("uses a fresh index session for each fix preview even after a base scan", async () => {
    const repository = await repositoryFixture();
    await repository.commitAll("committed target");
    const target = (await repository.git(["rev-parse", "HEAD"])).stdout.trim();
    await repository.write("value.ts", "export const value = 3;\n");
    await repository.git(["add", "--", "value.ts"]);
    const sources: string[] = [];
    const dispatch: typeof dispatchChecks = async (_adapters, context) => {
      sources.push(context.snapshots.targetRef);
      return [];
    };
    await runScan({
      repositoryRoot: repository.root,
      baseRef: "HEAD~1",
      cache: false,
      dependencies: {
        ...defaults,
        dispatch,
        evaluate: evaluatePolicy,
        now: () => new Date(),
      },
    });
    await analyze("fix", repository.root, { ...defaults, dispatch });
    await repository.git(["reset", "--", "value.ts"]);
    const empty = await analyze("fix", repository.root, {
      ...defaults,
      dispatch,
    });
    expect(sources).toEqual([target, "index"]);
    expect(empty).toHaveProperty("publicPlan.summary.fixes", 0);
    expect(empty).toHaveProperty("publicPlan.target", "index");
  });
});
