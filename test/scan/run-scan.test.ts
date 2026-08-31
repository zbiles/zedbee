import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { CheckResult } from "../../src/core/types.js";
import { createFilePolicyResolver } from "../../src/config/file-policy.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { ConfigError } from "../../src/config/load-config.js";
import { GitClient, type GitOutput } from "../../src/git/client.js";
import { GitCommandError } from "../../src/git/errors.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import type { SnapshotPair } from "../../src/git/snapshot.js";
import { buildSnapshotPair, SnapshotError } from "../../src/git/snapshot.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import {
  DEFAULT_CHECK_ADAPTERS,
  runScan,
  type RunScanDependencies,
} from "../../src/scan/run-scan.js";
import type { ScanEvent } from "../../src/checks/events.js";
import { prepareTerminalPresentation } from "../../src/reporting/presentation.js";
import { EMPTY_AGENT_GUIDANCE } from "../../src/reporting/agent-guidance.js";
import { unsupportedEntryFailures } from "../../src/scan/unsupported-inputs.js";
import type {
  TemporaryReportRequest,
  TemporaryReportStore,
} from "../../src/reporting/temporary-reports.js";

const config: ResolvedConfig = resolveConfig({
  schemaVersion: 1,
  profile: "recommended",
  checks: { formatting: "error" },
});

const nonEmptyChangeSet: ChangeSet = {
  files: new Map([
    [
      "value.ts",
      {
        path: "value.ts",
        status: "modified",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ],
  ]),
  isEmpty: false,
  containsAddedLine: () => true,
};

const emptyChangeSet: ChangeSet = {
  files: new Map(),
  isEmpty: true,
  containsAddedLine: () => false,
};

function addedChangeSet(...paths: readonly string[]): ChangeSet {
  return {
    files: new Map(
      paths.map((path) => [
        path,
        {
          path,
          status: "added" as const,
          addedRanges: [{ start: 1, end: 1 }],
        },
      ]),
    ),
    isEmpty: paths.length === 0,
    containsAddedLine: (file, line) => paths.includes(file) && line === 1,
  };
}

function configWithLintEnabledOnlyFor(files: readonly string[]): ResolvedConfig {
  return resolveConfig({
    schemaVersion: 1,
    profile: "fast",
    checks: {
      formatting: "off",
      lint: "off",
      types: "off",
      cyclomaticComplexity: "off",
      readabilityComplexity: "off",
      structuralSecurity: "off",
      secrets: "off",
      duplication: "off",
      dependencyArchitecture: "off",
      deadCode: "off",
      reactCorrectness: "off",
      reactAccessibility: "off",
      vulnerabilities: "off",
    },
    overrides: [{ files: [...files], checks: { lint: "error" } }],
  });
}

function snapshotsWithUnsupported(path: string, kind: "binary"): SnapshotPair {
  return {
    baselineDir: "/tmp/baseline",
    targetDir: "/tmp/target",
    baselineRef: "HEAD",
    unsupportedEntries: [{ path, kind }],
    cleanup: async () => undefined,
  };
}

function configWithRootLintDisabledForSource(): ResolvedConfig {
  return resolveConfig({
    schemaVersion: 1,
    profile: "fast",
    checks: {
      formatting: "off",
      lint: "error",
      types: "off",
      cyclomaticComplexity: "off",
      readabilityComplexity: "off",
      structuralSecurity: "off",
      secrets: "off",
      duplication: "off",
      dependencyArchitecture: "off",
      deadCode: "off",
      reactCorrectness: "off",
      reactAccessibility: "off",
      vulnerabilities: "off",
    },
    overrides: [
      { files: ["src/**"], checks: { lint: "off" } },
      { files: ["src/other.ts"], checks: { types: "error" } },
    ],
  });
}

const passing: CheckResult = {
  checkId: "formatting",
  status: "completed",
  durationMs: 2,
  findings: [],
};

const blocking: CheckResult = {
  checkId: "lint",
  status: "completed",
  durationMs: 3,
  findings: [
    {
      id: "lint:value.ts:1",
      check: "lint",
      rule: "no-debugger",
      severity: "error",
      message: "Remove debugger",
      location: { file: "value.ts", startLine: 1 },
      attribution: {
        kind: "range-overlap",
        staged: true,
        evidence: ["value.ts:1"],
      },
    },
  ],
};

function dependencies(
  calls: string[],
  overrides: Partial<RunScanDependencies> = {},
): RunScanDependencies {
  const snapshots: SnapshotPair = {
    baselineDir: "/tmp/baseline",
    targetDir: "/tmp/target",
    baselineRef: "HEAD",
    unsupportedEntries: [],
    cleanup: async () => {
      calls.push("clean snapshots");
    },
  };
  const inspection = (snapshotRoot: string): RepositoryInspection => ({
    snapshotRoot,
    packageManager: "npm",
    lockfiles: ["package-lock.json"],
    workspaces: [
      {
        relativeRoot: ".",
        manifestPath: "package.json",
        sourceFiles: ["value.ts"],
        tsconfigPaths: [],
        environments: ["javascript", "typescript"],
        dependencyDeclarations: [],
      },
    ],
  });
  let tick = 0;
  return {
    loadConfig: async () => {
      calls.push("load config");
      return config;
    },
    createGitClient: () => ({}) as GitClient,
    readChangeSet: async () => {
      calls.push("read staged changes");
      return nonEmptyChangeSet;
    },
    buildSnapshots: async () => {
      calls.push("build snapshots");
      return snapshots;
    },
    inspectRepository: async (snapshotRoot) => {
      calls.push(`inspect ${snapshotRoot}`);
      return inspection(snapshotRoot);
    },
    baselineForEmptyChange: async () => "HEAD",
    dispatch: async () => {
      calls.push("dispatch checks");
      return [
        {
          result: passing,
          policy: Object.freeze({ ...config.checks.formatting }),
        },
      ];
    },
    evaluate: (results, resolvedConfig) => {
      calls.push("evaluate policy");
      return evaluatePolicy(results, resolvedConfig);
    },
    adapters: [],
    now: () => new Date("2026-08-15T00:00:00.000Z"),
    clock: () => tick++,
    ...overrides,
  };
}

function delayedGitCommand(delayMs: number) {
  return async (
    _args: readonly string[],
    options: Readonly<{ signal?: AbortSignal }>,
  ): Promise<GitOutput> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ stdout: "", stderr: "", exitCode: 0 }),
        delayMs,
      );
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
}

describe("runScan", () => {
  it("maps a bounded Git output failure to a sanitized incomplete report", async () => {
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        readChangeSet: async () => {
          throw new GitCommandError(
            "GIT_OUTPUT_LIMIT_EXCEEDED",
            "sensitive Git output",
          );
        },
      }),
    });

    expect(report.checks[0]?.error?.code).toBe("GIT_OUTPUT_LIMIT_EXCEEDED");
    expect(report.outcome).toBe("incomplete");
    expect(JSON.stringify(report)).not.toContain("sensitive");
  });

  it("continues after a configured Git soft timeout", async () => {
    const events: unknown[] = [];
    const softTimeoutConfig = resolveConfig({
      schemaVersion: 1,
      resources: { git: { softTimeout: "5ms" } },
    });
    const report = await runScan({
      repositoryRoot: "/repo",
      onEvent: (event) => events.push(event),
      dependencies: dependencies([], {
        loadConfig: async () => softTimeoutConfig,
        createGitClient: (root, options) =>
          new GitClient(root, {
            ...options,
            runCommand: delayedGitCommand(20),
          }),
        readChangeSet: async (git, signal) => {
          await git.run(
            ["status"],
            signal === undefined ? {} : { signal },
          );
          return nonEmptyChangeSet;
        },
      }),
    });

    expect(report.outcome).toBe("pass");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "git-soft-timeout" }),
    );
  });

  it("returns incomplete after an explicitly configured Git hard timeout", async () => {
    const hardTimeoutConfig = resolveConfig({
      schemaVersion: 1,
      resources: { git: { hardTimeout: "5ms" } },
    });
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        loadConfig: async () => hardTimeoutConfig,
        createGitClient: (root, options) =>
          new GitClient(root, {
            ...options,
            runCommand: delayedGitCommand(20),
          }),
        readChangeSet: async (git, signal) => {
          await git.run(
            ["status"],
            signal === undefined ? {} : { signal },
          );
          return nonEmptyChangeSet;
        },
      }),
    });

    expect(report).toMatchObject({
      outcome: "incomplete",
      checks: [{ error: { code: "GIT_HARD_TIMEOUT" } }],
    });
  });

  it("bypasses a configured Git hard timeout when noTimeout is set", async () => {
    const hardTimeoutConfig = resolveConfig({
      schemaVersion: 1,
      resources: { git: { hardTimeout: "5ms" } },
    });
    const report = await runScan({
      repositoryRoot: "/repo",
      noTimeout: true,
      dependencies: dependencies([], {
        loadConfig: async () => hardTimeoutConfig,
        createGitClient: (root, options) =>
          new GitClient(root, {
            ...options,
            runCommand: delayedGitCommand(20),
          }),
        readChangeSet: async (git, signal) => {
          await git.run(
            ["status"],
            signal === undefined ? {} : { signal },
          );
          return nonEmptyChangeSet;
        },
      }),
    });

    expect(report.outcome).toBe("pass");
  });

  it("propagates its abort signal to staged change discovery", async () => {
    const controller = new AbortController();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const deps = dependencies([], {
      readChangeSet: async (_git, signal?: AbortSignal) => {
        receivedSignal = signal;
        resolveStarted?.();
        return new Promise<ChangeSet>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                new GitCommandError("GIT_ABORTED", "Git command was aborted."),
              ),
            { once: true },
          );
        });
      },
    });

    const pending = runScan({
      repositoryRoot: "/repo",
      signal: controller.signal,
      dependencies: deps,
    });
    await started;
    controller.abort();

    await expect(
      Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                new Error("change discovery did not receive the abort signal"),
              ),
            100,
          );
        }),
      ]),
    ).rejects.toMatchObject({ code: "GIT_ABORTED" });
    expect(receivedSignal).toBe(controller.signal);
  });

  it("propagates its abort signal to snapshot construction", async () => {
    const controller = new AbortController();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const deps = dependencies([], {
      buildSnapshots: async (_repositoryRoot, _git, signal?: AbortSignal) => {
        receivedSignal = signal;
        resolveStarted?.();
        return new Promise<SnapshotPair>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                new GitCommandError("GIT_ABORTED", "Git command was aborted."),
              ),
            { once: true },
          );
        });
      },
    });

    const pending = runScan({
      repositoryRoot: "/repo",
      signal: controller.signal,
      dependencies: deps,
    });
    await started;
    controller.abort();

    await expect(
      Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                new Error("snapshot construction did not receive the abort signal"),
              ),
            100,
          );
        }),
      ]),
    ).rejects.toMatchObject({ code: "GIT_ABORTED" });
    expect(receivedSignal).toBe(controller.signal);
  });

  it("cleans snapshots and preserves the abort outcome after construction", async () => {
    const controller = new AbortController();
    const abortError = new GitCommandError(
      "GIT_ABORTED",
      "Git command was aborted.",
    );
    let cleanupCalls = 0;
    let resolveDispatchStarted: (() => void) | undefined;
    const dispatchStarted = new Promise<void>((resolve) => {
      resolveDispatchStarted = resolve;
    });
    const deps = dependencies([], {
      buildSnapshots: async () => ({
        baselineDir: "/tmp/baseline",
        targetDir: "/tmp/target",
        baselineRef: "HEAD",
        unsupportedEntries: [],
        cleanup: async () => {
          cleanupCalls++;
        },
      }),
      dispatch: async (_adapters, { signal }) => {
        resolveDispatchStarted?.();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(abortError), {
            once: true,
          });
        });
      },
    });

    const pending = runScan({
      repositoryRoot: "/repo",
      signal: controller.signal,
      dependencies: deps,
    });
    await dispatchStarted;
    controller.abort();

    await expect(pending).rejects.toBe(abortError);
    expect(cleanupCalls).toBe(1);
  });

  it("uses the effective target policy for unsupported inputs", () => {
    const changeSet = addedChangeSet("src/matched.ts", "src/other.ts");
    const changedPaths = new Set(changeSet.files.keys());
    const policyForFile = createFilePolicyResolver(
      configWithRootLintDisabledForSource(),
      changeSet,
    );
    const entries = [
      { path: "src/matched.ts", kind: "binary" },
      { path: "src/other.ts", kind: "binary" },
    ] as const;

    expect(
      unsupportedEntryFailures([entries[0]], changedPaths, policyForFile),
    ).toEqual([]);
    expect(
      unsupportedEntryFailures(entries, changedPaths, policyForFile),
    ).toMatchObject([
      { code: "UNSUPPORTED_BINARY_INPUT", path: "src/other.ts" },
    ]);
  });

  it("publishes the managed adapters in deterministic check order", () => {
    expect(DEFAULT_CHECK_ADAPTERS.map(({ id }) => id)).toEqual([
      "formatting",
      "lint",
      "types",
      "cyclomaticComplexity",
      "readabilityComplexity",
      "structuralSecurity",
      "secrets",
      "duplication",
      "dependencyArchitecture",
      "deadCode",
      "reactCorrectness",
      "reactAccessibility",
      "vulnerabilities",
    ]);
  });

  it("persists network disclosures even without an external event observer", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, {
      dispatch: async (_adapters, _context, options) => {
        options?.onEvent?.({
          type: "network-disclosure",
          checkId: "vulnerabilities",
          target: ".",
          timestamp: 1,
          services: ["api.osv.dev"],
          metadata: [
            "package names",
            "exact versions",
            "ecosystem identifiers",
          ],
        });
        return [
          {
            result: passing,
            policy: Object.freeze({ ...config.checks.formatting }),
          },
        ];
      },
    });

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: deps,
    });

    expect(report.networkDisclosures).toEqual([
      {
        checkId: "vulnerabilities",
        target: ".",
        services: ["api.osv.dev"],
        metadata: ["package names", "exact versions", "ecosystem identifiers"],
      },
    ]);
    expect(Object.isFrozen(report.networkDisclosures)).toBe(true);
  });

  it("fails closed for LFS but passes an intent-only index without dispatching", async () => {
    let dispatchCalls = 0;
    const lfsReport = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        readChangeSet: async () => addedChangeSet("asset.dat"),
        buildSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          unsupportedEntries: [{ path: "asset.dat", kind: "git-lfs-pointer" }],
          cleanup: async () => undefined,
        }),
        dispatch: async () => {
          dispatchCalls += 1;
          return [];
        },
      }),
    });
    const intentOnlyReport = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        readChangeSet: async () => emptyChangeSet,
        buildSnapshots: async () => {
          throw new Error("snapshots must not be built");
        },
        dispatch: async () => {
          dispatchCalls += 1;
          return [];
        },
      }),
    });

    expect(lfsReport).toMatchObject({ outcome: "incomplete", exitCode: 2 });
    expect(intentOnlyReport).toMatchObject({
      outcome: "pass",
      exitCode: 0,
      stagedFileCount: 0,
    });
    expect(dispatchCalls).toBe(0);
  });

  it("reports every unsupported staged path relevant to enabled checks", async () => {
    let dispatchCalls = 0;
    const unsupportedPaths = [
      "vendor/demo",
      "src/generated.js",
      "assets/photo.png",
      "assets/first.dat",
      "assets/second.dat",
    ];
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        readChangeSet: async () => ({
          files: new Map(
            unsupportedPaths.map((path) => [
              path,
              {
                path,
                status: "added" as const,
                addedRanges: [{ start: 1, end: 1 }],
              },
            ]),
          ),
          isEmpty: false,
          containsAddedLine: () => true,
        }),
        buildSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          unsupportedEntries: [
            { path: "vendor/demo", kind: "submodule" },
            { path: "src/generated.js", kind: "binary" },
            { path: "assets/photo.png", kind: "binary" },
            { path: "assets/first.dat", kind: "git-lfs-pointer" },
            { path: "assets/second.dat", kind: "git-lfs-pointer" },
          ],
          cleanup: async () => undefined,
        }),
        dispatch: async () => {
          dispatchCalls += 1;
          return [];
        },
      }),
    });

    expect(report).toMatchObject({
      outcome: "incomplete",
      exitCode: 2,
      summary: { incomplete: 4 },
    });
    expect(report.checks.map(({ error }) => error)).toMatchObject([
      { code: "GIT_LFS_POINTER", path: "assets/first.dat" },
      { code: "GIT_LFS_POINTER", path: "assets/second.dat" },
      { code: "UNSUPPORTED_BINARY_INPUT", path: "src/generated.js" },
      { code: "GIT_SUBMODULE_UNAVAILABLE", path: "vendor/demo" },
    ]);
    expect(JSON.stringify(report)).not.toContain("assets/photo.png");
    expect(dispatchCalls).toBe(0);
  });

  it("does not report an unchanged unsupported index entry", async () => {
    let dispatchCalls = 0;
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        buildSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          unsupportedEntries: [{ path: "legacy/binary.js", kind: "binary" }],
          cleanup: async () => undefined,
        }),
        dispatch: async () => {
          dispatchCalls += 1;
          return [
            {
              result: passing,
              policy: Object.freeze({ ...config.checks.formatting }),
            },
          ];
        },
      }),
    });

    expect(report).toMatchObject({ outcome: "pass", exitCode: 0 });
    expect(dispatchCalls).toBe(1);
  });

  it("treats a file-scoped enabled check as relevant to binary input", async () => {
    const overrideConfig = resolveConfig({
      schemaVersion: 1,
      profile: "fast",
      checks: {
        formatting: "off",
        lint: "off",
        cyclomaticComplexity: "off",
        readabilityComplexity: "off",
        structuralSecurity: "off",
        reactCorrectness: "off",
        reactAccessibility: "off",
      },
      overrides: [{ files: ["binary.js"], checks: { lint: "error" } }],
    });
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        loadConfig: async () => overrideConfig,
        readChangeSet: async () => ({
          files: new Map([
            [
              "binary.js",
              {
                path: "binary.js",
                status: "added",
                addedRanges: [{ start: 1, end: 1 }],
              },
            ],
          ]),
          isEmpty: false,
          containsAddedLine: () => true,
        }),
        buildSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          unsupportedEntries: [{ path: "binary.js", kind: "binary" }],
          cleanup: async () => undefined,
        }),
      }),
    });

    expect(report.checks).toMatchObject([
      {
        status: "incomplete",
        error: { code: "UNSUPPORTED_BINARY_INPUT", path: "binary.js" },
      },
    ]);
  });

  it("does not reject a binary outside an enabled path override", async () => {
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        loadConfig: async () => configWithLintEnabledOnlyFor(["src/**"]),
        readChangeSet: async () => addedChangeSet("vendor/generated.ts"),
        buildSnapshots: async () =>
          snapshotsWithUnsupported("vendor/generated.ts", "binary"),
      }),
    });

    expect(report.checks).not.toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "UNSUPPORTED_BINARY_INPUT" }),
      }),
    );
  });

  it("rejects a binary inside an enabled path override", async () => {
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        loadConfig: async () => configWithLintEnabledOnlyFor(["src/**"]),
        readChangeSet: async () => addedChangeSet("src/generated.ts"),
        buildSnapshots: async () =>
          snapshotsWithUnsupported("src/generated.ts", "binary"),
      }),
    });

    expect(report).toMatchObject({ outcome: "incomplete", exitCode: 2 });
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        status: "incomplete",
        error: expect.objectContaining({
          code: "UNSUPPORTED_BINARY_INPUT",
          path: "src/generated.ts",
        }),
      }),
    );
  });

  it("allows irrelevant binary artifacts to proceed", async () => {
    let dispatchCalls = 0;
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        loadConfig: async () => configWithLintEnabledOnlyFor(["src/**"]),
        readChangeSet: async () => addedChangeSet("assets/photo.png"),
        buildSnapshots: async () =>
          snapshotsWithUnsupported("assets/photo.png", "binary"),
        dispatch: async () => {
          dispatchCalls += 1;
          return [];
        },
      }),
    });

    expect(report).toMatchObject({ outcome: "pass", exitCode: 0 });
    expect(dispatchCalls).toBe(1);
  });

  it("uses a renamed file's target path for override relevance", async () => {
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        loadConfig: async () => configWithLintEnabledOnlyFor(["src/**"]),
        readChangeSet: async () => ({
          files: new Map([
            [
              "src/generated.ts",
              {
                path: "src/generated.ts",
                previousPath: "vendor/generated.ts",
                status: "renamed",
                addedRanges: [],
              },
            ],
          ]),
          isEmpty: false,
          containsAddedLine: () => false,
        }),
        buildSnapshots: async () =>
          snapshotsWithUnsupported("src/generated.ts", "binary"),
      }),
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "UNSUPPORTED_BINARY_INPUT",
          path: "src/generated.ts",
        }),
      }),
    );
  });

  it("ignores a renamed file's baseline path for override relevance", async () => {
    let dispatchCalls = 0;
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        loadConfig: async () => configWithLintEnabledOnlyFor(["src/**"]),
        readChangeSet: async () => ({
          files: new Map([
            [
              "vendor/generated.ts",
              {
                path: "vendor/generated.ts",
                previousPath: "src/generated.ts",
                status: "renamed",
                addedRanges: [],
              },
            ],
          ]),
          isEmpty: false,
          containsAddedLine: () => false,
        }),
        buildSnapshots: async () =>
          snapshotsWithUnsupported("vendor/generated.ts", "binary"),
        dispatch: async () => {
          dispatchCalls += 1;
          return [];
        },
      }),
    });

    expect(report).toMatchObject({ outcome: "pass", exitCode: 0 });
    expect(dispatchCalls).toBe(1);
  });

  it("allows ordinary binary assets to proceed with secrets enabled", async () => {
    let dispatchCalls = 0;
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        readChangeSet: async () => ({
          files: new Map([
            [
              "assets/photo.png",
              {
                path: "assets/photo.png",
                status: "added",
                addedRanges: [],
              },
            ],
          ]),
          isEmpty: false,
          containsAddedLine: () => false,
        }),
        buildSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          unsupportedEntries: [{ path: "assets/photo.png", kind: "binary" }],
          cleanup: async () => undefined,
        }),
        dispatch: async () => {
          dispatchCalls += 1;
          return [
            {
              result: passing,
              policy: Object.freeze({ ...config.checks.formatting }),
            },
          ];
        },
      }),
    });

    expect(report).toMatchObject({ outcome: "pass", exitCode: 0 });
    expect(dispatchCalls).toBe(1);
  });

  it("preserves findings and disclosures when snapshot cleanup fails", async () => {
    const calls: string[] = [];
    const created = await mkdtemp(join(tmpdir(), "zedbee-snapshot-cleanup-"));
    const canonicalSnapshotRoot = await realpath(created);
    onTestFinished(() => rm(canonicalSnapshotRoot, { recursive: true }));
    const cleanupConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      failOnIncomplete: false,
      checks: { formatting: "error", lint: "error" },
    });
    const deps = dependencies(calls, {
      loadConfig: async () => cleanupConfig,
      buildSnapshots: async () => ({
        baselineDir: join(canonicalSnapshotRoot, "baseline"),
        targetDir: join(canonicalSnapshotRoot, "target"),
        baselineRef: "HEAD",
        unsupportedEntries: [],
        cleanup: async () => {
          throw new Error("sensitive cleanup failure");
        },
      }),
      dispatch: async (_adapters, _context, options) => {
        options?.onEvent?.({
          type: "network-disclosure",
          checkId: "vulnerabilities",
          target: ".",
          timestamp: 1,
          services: ["api.osv.dev"],
          metadata: ["package names", "versions"],
        });
        return [
          {
            result: passing,
            policy: Object.freeze({ ...cleanupConfig.checks.formatting }),
          },
          {
            result: blocking,
            policy: Object.freeze({ ...cleanupConfig.checks.lint }),
          },
        ];
      },
    });

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: deps,
    });

    expect(report).toMatchObject({
      outcome: "incomplete",
      exitCode: 2,
      summary: { passed: 1, failed: 1, incomplete: 1 },
      networkDisclosures: [
        {
          checkId: "vulnerabilities",
          target: ".",
          services: ["api.osv.dev"],
          metadata: ["package names", "versions"],
        },
      ],
    });
    expect(report.checks.map(({ checkId }) => checkId)).toEqual([
      "formatting",
      "lint",
      "zedbee",
    ]);
    expect(report.checks.at(-1)?.error).toMatchObject({
      code: "SNAPSHOT_CLEANUP_FAILED",
      temporaryPath: canonicalSnapshotRoot,
      remediation:
        "Inspect and remove the listed Zedbee snapshot, then verify temporary-directory permissions or locks. A persistent filesystem or path-identity problem can cause later cleanups to fail and leave additional snapshots.",
    });
    expect(JSON.stringify(report)).not.toContain("sensitive cleanup failure");
  });

  it.runIf(process.platform !== "win32")(
    "preserves findings without exposing a snapshot path when cleanup validation fails",
    async () => {
      const calls: string[] = [];
      const created = await mkdtemp(
        join(tmpdir(), "zedbee-snapshot-identity-"),
      );
      const canonicalSnapshotRoot = await realpath(created);
      const movedSnapshotRoot = `${canonicalSnapshotRoot}-moved`;
      onTestFinished(async () => {
        await rm(canonicalSnapshotRoot, { force: true });
        await rm(movedSnapshotRoot, { recursive: true, force: true });
      });
      const cleanupConfig = resolveConfig({
        schemaVersion: 1,
        profile: "recommended",
        failOnIncomplete: false,
        checks: { formatting: "error", lint: "error" },
      });
      const deps = dependencies(calls, {
        loadConfig: async () => cleanupConfig,
        buildSnapshots: async () => ({
          baselineDir: join(canonicalSnapshotRoot, "baseline"),
          targetDir: join(canonicalSnapshotRoot, "target"),
          baselineRef: "HEAD",
          unsupportedEntries: [],
          cleanup: async () => {
            await rename(canonicalSnapshotRoot, movedSnapshotRoot);
            await symlink(movedSnapshotRoot, canonicalSnapshotRoot, "dir");
            throw new Error("sensitive cleanup identity failure");
          },
        }),
        dispatch: async () => [
          {
            result: passing,
            policy: Object.freeze({ ...cleanupConfig.checks.formatting }),
          },
          {
            result: blocking,
            policy: Object.freeze({ ...cleanupConfig.checks.lint }),
          },
        ],
      });

      const report = await runScan({
        repositoryRoot: "/repo",
        dependencies: deps,
      });

      expect(report).toMatchObject({
        outcome: "incomplete",
        exitCode: 2,
        summary: { passed: 1, failed: 1, incomplete: 1 },
      });
      expect(report.checks.map(({ checkId }) => checkId)).toEqual([
        "formatting",
        "lint",
        "zedbee",
      ]);
      expect(report.checks.at(-1)?.error).toEqual({
        code: "SNAPSHOT_CLEANUP_FAILED",
        message:
          "Zedbee could not remove its temporary snapshot or safely identify the remaining directory.",
        remediation:
          "Inspect the OS temporary directory for zedbee-snapshot-* directories and remove any stale Zedbee snapshots, then verify temporary-directory permissions or locks. A persistent filesystem or path-identity problem can cause later cleanups to fail and leave additional snapshots.",
      });
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain("sensitive cleanup identity failure");
      expect(serialized).not.toContain(canonicalSnapshotRoot);
      expect(serialized).not.toContain(movedSnapshotRoot);
    },
  );

  it
    .runIf(process.platform !== "win32")
    .each(["validated", "unreportable"] as const)(
    "reports construction and %s construction-cleanup failures together",
    async (pathMode) => {
      let snapshotRoot: string | undefined;
      let movedSnapshotRoot: string | undefined;
      const rawFailure = `RAW-CONSTRUCTION-${pathMode} /private/unsafe/path`;
      const git = {
        async run(args: readonly string[]) {
          if (args[0] === "checkout-index") {
            const prefix = args.find((arg) => arg.startsWith("--prefix="))!;
            const targetDir = prefix
              .slice("--prefix=".length)
              .replace(/[/\\]+$/u, "");
            snapshotRoot = dirname(targetDir);
            if (pathMode === "validated") {
              await chmod(snapshotRoot, 0o500);
            } else {
              movedSnapshotRoot = `${snapshotRoot}-moved`;
              await rename(snapshotRoot, movedSnapshotRoot);
              await symlink(movedSnapshotRoot, snapshotRoot, "dir");
            }
            throw new Error(rawFailure);
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async tryRun() {
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      } as unknown as GitClient;
      onTestFinished(async () => {
        if (snapshotRoot !== undefined) {
          await chmod(snapshotRoot, 0o700).catch(() => undefined);
          await rm(snapshotRoot, { recursive: true, force: true });
        }
        if (movedSnapshotRoot !== undefined) {
          await rm(movedSnapshotRoot, { recursive: true, force: true });
        }
      });
      const deps = dependencies([], {
        createGitClient: () => git,
        buildSnapshots: buildSnapshotPair,
      });

      const report = await runScan({
        repositoryRoot: "/repo",
        dependencies: deps,
      });

      expect(report).toMatchObject({
        outcome: "incomplete",
        exitCode: 2,
        stagedFileCount: 1,
        summary: { incomplete: 2 },
      });
      expect(report.checks.map(({ error }) => error?.code)).toEqual([
        "SNAPSHOT_CONSTRUCTION_FAILED",
        "SNAPSHOT_CLEANUP_FAILED",
      ]);
      if (pathMode === "validated") {
        expect(report.checks[1]?.error?.temporaryPath).toBe(snapshotRoot);
      } else {
        expect(report.checks[1]?.error).not.toHaveProperty("temporaryPath");
      }
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(rawFailure);
      expect(serialized).not.toContain("/private/unsafe/path");
      if (pathMode === "unreportable") {
        expect(serialized).not.toContain(snapshotRoot);
        expect(serialized).not.toContain(movedSnapshotRoot);
      }
    },
  );

  it("rejects with the abort reason when cancellation occurs during failed cleanup", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const abortReason = new DOMException("scan cancelled", "AbortError");
    const deps = dependencies(calls, {
      buildSnapshots: async () => ({
        baselineDir: "/tmp/baseline",
        targetDir: "/tmp/target",
        baselineRef: "HEAD",
        unsupportedEntries: [],
        cleanup: async () => {
          controller.abort(abortReason);
          throw new Error("sensitive cleanup failure");
        },
      }),
    });

    await expect(
      runScan({
        repositoryRoot: "/repo",
        signal: controller.signal,
        dependencies: deps,
      }),
    ).rejects.toBe(abortReason);
  });

  it("rejects with the abort reason when cancellation occurs during successful cleanup", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const abortReason = new DOMException(
      "cleanup completed after cancellation",
      "AbortError",
    );
    const deps = dependencies(calls, {
      buildSnapshots: async () => ({
        baselineDir: "/tmp/baseline",
        targetDir: "/tmp/target",
        baselineRef: "HEAD",
        unsupportedEntries: [],
        cleanup: async () => {
          controller.abort(abortReason);
        },
      }),
    });

    await expect(
      runScan({
        repositoryRoot: "/repo",
        signal: controller.signal,
        dependencies: deps,
      }),
    ).rejects.toBe(abortReason);
  });

  it.each([
    {
      phase: "configuration",
      expected: {
        code: "CONFIG_INVALID",
        message: "Zedbee could not load a valid configuration.",
        remediation: "Fix the Zedbee configuration and run the scan again.",
      },
    },
    {
      phase: "change discovery",
      expected: {
        code: "CHANGE_DISCOVERY_FAILED",
        message: "Zedbee could not read the staged changes.",
        remediation: "Resolve the Git index problem and run the scan again.",
      },
    },
    {
      phase: "unresolved merge entries",
      expected: {
        code: "UNRESOLVED_INDEX",
        message: "Zedbee cannot scan an index with unresolved entries.",
        remediation: "Resolve the staged merge entries and run the scan again.",
      },
    },
    {
      phase: "invalid index path",
      expected: {
        code: "INVALID_INDEX_PATH",
        message: "Zedbee refused an invalid staged repository path.",
        remediation:
          "Repair or remove the invalid Git index entry and run the scan again.",
      },
    },
    {
      phase: "snapshot construction",
      expected: {
        code: "SNAPSHOT_CONSTRUCTION_FAILED",
        message: "Zedbee could not construct the staged snapshots.",
        remediation:
          "Check the Git index and temporary-directory permissions, then retry.",
      },
    },
    {
      phase: "baseline inspection",
      expected: {
        code: "BASELINE_INSPECTION_FAILED",
        message: "Zedbee could not inspect the baseline snapshot.",
        remediation:
          "Check the baseline repository metadata and run the scan again.",
      },
    },
    {
      phase: "target inspection",
      expected: {
        code: "TARGET_INSPECTION_FAILED",
        message: "Zedbee could not inspect the staged snapshot.",
        remediation:
          "Check the staged repository metadata and run the scan again.",
      },
    },
    {
      phase: "dispatch",
      expected: {
        code: "CHECK_DISPATCH_FAILED",
        message: "Zedbee could not dispatch the configured checks.",
        remediation:
          "Review the check diagnostics, run zedbee doctor, and retry.",
      },
    },
  ])("reports a safe $phase diagnostic", async ({ phase, expected }) => {
    const calls: string[] = [];
    const deps = dependencies(calls, {
      ...(phase === "configuration"
        ? {
            loadConfig: async () => {
              throw new ConfigError(
                "CONFIG_INVALID",
                "private-token-123",
                "/repo/.zedbeerc.jsonc",
              );
            },
          }
        : {}),
      ...(phase === "change discovery"
        ? {
            readChangeSet: async () => {
              throw new Error("private-token-123");
            },
          }
        : {}),
      ...(phase === "unresolved merge entries"
        ? {
            buildSnapshots: async () => {
              throw new SnapshotError("UNRESOLVED_INDEX", "private-token-123");
            },
          }
        : {}),
      ...(phase === "invalid index path"
        ? {
            buildSnapshots: async () => {
              throw new SnapshotError(
                "INVALID_INDEX_PATH",
                "private-token-123 /outside/repository",
              );
            },
          }
        : {}),
      ...(phase === "snapshot construction"
        ? {
            buildSnapshots: async () => {
              throw new Error("private-token-123");
            },
          }
        : {}),
      ...(phase === "baseline inspection"
        ? {
            inspectRepository: async () => {
              throw new Error("private-token-123");
            },
          }
        : {}),
      ...(phase === "target inspection"
        ? {
            inspectRepository: async (snapshotRoot: string) => {
              if (snapshotRoot.endsWith("target")) {
                throw new Error("private-token-123");
              }
              return {
                snapshotRoot,
                packageManager: "npm" as const,
                lockfiles: ["package-lock.json"],
                workspaces: [],
              };
            },
          }
        : {}),
      ...(phase === "dispatch"
        ? {
            dispatch: async () => {
              throw new Error("private-token-123");
            },
          }
        : {}),
    });

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: deps,
    });

    expect(report.checks).toMatchObject([
      {
        checkId: "zedbee",
        status: "incomplete",
        error: expected,
      },
    ]);
    expect(report.presentationPolicy).toEqual({
      terminalFindingLimit: 25,
      temporaryReportMaxAge: "24h",
      persistSourceExcerpts: false,
      agentGuidance: EMPTY_AGENT_GUIDANCE,
    });
    expect(Object.isFrozen(report.presentationPolicy)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private-token-123");
  });

  it("reports the repository-relative path for a staged Git LFS pointer", async () => {
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        readChangeSet: async () => addedChangeSet("assets/large.dat"),
        buildSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          unsupportedEntries: [
            { path: "assets/large.dat", kind: "git-lfs-pointer" },
          ],
          cleanup: async () => undefined,
        }),
      }),
    });

    expect(report.checks).toMatchObject([
      {
        checkId: "zedbee",
        status: "incomplete",
        error: {
          code: "GIT_LFS_POINTER",
          message: "Zedbee cannot inspect a staged Git LFS pointer.",
          path: "assets/large.dat",
          remediation:
            "Materialize the Git LFS object for this path, stage it again, and rerun the scan.",
        },
      },
    ]);
  });

  it("publishes only documented result fields from an untrusted adapter", async () => {
    const calls: string[] = [];
    const events: ScanEvent[] = [];
    let unexpectedTargetReads = 0;
    const deps = dependencies(calls, {
      dispatch: dispatchChecks,
      adapters: [
        {
          id: "formatting",
          output: "legacy-check-result",
          inspect: async () => ({
            applies: true,
            executionClass: "lightweight",
            requiresBaseline: false,
            targets: [
              {
                id: "workspace",
                kind: "workspace",
                relativeRoot: ".",
                adapterTargetSecret: "must not escape",
                get unexpectedTarget() {
                  unexpectedTargetReads += 1;
                  throw new Error("must not be read");
                },
              } as unknown as import("../../src/checks/adapter.js").CheckTarget,
            ],
          }),
          runLegacy: async () => ({
            checkId: "adapter-controlled",
            status: "completed",
            durationMs: 999,
            findings: [
              {
                id: "formatting:value.ts:1",
                check: "formatting",
                rule: "prettier",
                severity: "info",
                message: "Format value.ts",
                location: {
                  file: "value.ts",
                  startLine: 1,
                  unexpectedLocation: "must not escape",
                },
                remediation: "Run the formatter",
                attribution: {
                  kind: "range-overlap",
                  staged: true,
                  evidence: ["value.ts:1"],
                  unexpectedAttribution: "must not escape",
                },
                unexpectedFinding: "must not escape",
              },
            ],
            error: {
              code: "IGNORED_FOR_COMPLETED_RESULT",
              message: "public error fields remain explicit",
              unexpectedError: "must not escape",
            },
            policy: { severity: "off" },
            targetPolicy: { severity: "off" },
            unexpectedResult: "must not escape",
          }),
        },
      ],
    });

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: deps,
      onEvent: (event) => events.push(event),
    });
    const completedEvent = events.find(
      (event): event is Extract<ScanEvent, { type: "check-completed" }> =>
        event.type === "check-completed",
    );

    expect(completedEvent).toBeDefined();
    expect(unexpectedTargetReads).toBe(0);
    expect(Object.keys(completedEvent!.result)).toEqual([
      "checkId",
      "target",
      "status",
      "durationMs",
      "findings",
      "error",
    ]);
    expect(Object.keys(completedEvent!.result.findings[0]!)).toEqual([
      "id",
      "check",
      "rule",
      "severity",
      "message",
      "location",
      "remediation",
      "attribution",
    ]);
    expect(Object.keys(completedEvent!.result.findings[0]!.location!)).toEqual([
      "file",
      "startLine",
    ]);
    expect(
      Object.keys(completedEvent!.result.findings[0]!.attribution),
    ).toEqual(["kind", "staged", "evidence"]);
    expect(Object.keys(completedEvent!.result.error!)).toEqual([
      "code",
      "message",
    ]);

    const serialized = JSON.parse(JSON.stringify(report)) as {
      checks: Array<
        Record<string, unknown> & { findings: Record<string, unknown>[] }
      >;
      summary: { findings: Record<string, unknown>[] };
    };
    expect(Object.keys(serialized.checks[0]!)).toEqual([
      "checkId",
      "target",
      "status",
      "durationMs",
      "findings",
      "error",
    ]);
    expect(Object.keys(serialized.checks[0]!.findings[0]!)).toEqual([
      "id",
      "check",
      "rule",
      "severity",
      "message",
      "location",
      "remediation",
      "attribution",
    ]);
    expect(Object.keys(serialized.summary.findings[0]!)).toEqual([
      "id",
      "check",
      "rule",
      "severity",
      "message",
      "location",
      "remediation",
      "attribution",
    ]);
    expect(serialized.checks[0]).toMatchObject({
      checkId: "formatting",
      target: "workspace",
      findings: [{ severity: "error" }],
    });
    expect(
      JSON.stringify({
        completedEvent,
        checks: report.checks,
        summary: report.summary,
      }),
    ).not.toMatch(/policy|unexpected/i);
  });

  it("blocks with a target error override even when the root check only warns", async () => {
    const calls: string[] = [];
    const targetConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: "warn" },
      overrides: [{ files: ["apps/web/**"], checks: { formatting: "error" } }],
    });
    const deps = dependencies(calls, {
      loadConfig: async () => targetConfig,
      readChangeSet: async () => addedChangeSet("apps/web/value.ts"),
      inspectRepository: async (snapshotRoot) => ({
        snapshotRoot,
        packageManager: "npm",
        lockfiles: ["package-lock.json"],
        workspaces: [
          {
            relativeRoot: ".",
            manifestPath: "package.json",
            sourceFiles: [],
            tsconfigPaths: [],
            environments: ["javascript"],
            dependencyDeclarations: [],
          },
          {
            relativeRoot: "apps/web",
            manifestPath: "apps/web/package.json",
            sourceFiles: ["apps/web/value.ts"],
            tsconfigPaths: ["apps/web/tsconfig.json"],
            environments: ["javascript", "typescript"],
            dependencyDeclarations: [],
          },
        ],
      }),
      dispatch: dispatchChecks,
      adapters: [
        {
          id: "formatting",
          output: "legacy-check-result",
          inspect: async () => ({
            applies: true,
            executionClass: "lightweight",
            requiresBaseline: false,
            targets: [
              { id: "web-output", kind: "workspace", relativeRoot: "apps/web" },
            ],
          }),
          runLegacy: async () => ({
            checkId: "formatting",
            status: "completed",
            durationMs: 0,
            findings: [
              {
                id: "web-format",
                check: "formatting",
                rule: "prettier",
                severity: "info",
                message: "Format web file",
                location: { file: "apps/web/value.ts", startLine: 1 },
                attribution: {
                  kind: "range-overlap",
                  staged: true,
                  evidence: ["apps/web/value.ts:1"],
                },
              },
            ],
          }),
        },
      ],
    });

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: deps,
    });

    expect(report).toMatchObject({
      outcome: "blocked",
      exitCode: 1,
      checks: [
        {
          checkId: "formatting",
          target: "web-output",
          findings: [{ severity: "error" }],
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("policy");
  });

  it("retains a target incomplete result when the root check is off", async () => {
    const calls: string[] = [];
    const targetConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: "off" },
      overrides: [{ files: ["apps/web/**"], checks: { formatting: "error" } }],
    });
    const deps = dependencies(calls, {
      loadConfig: async () => targetConfig,
      readChangeSet: async () => addedChangeSet("apps/web/value.ts"),
      inspectRepository: async (snapshotRoot) => ({
        snapshotRoot,
        packageManager: "npm",
        lockfiles: ["package-lock.json"],
        workspaces: [
          {
            relativeRoot: "apps/web",
            manifestPath: "apps/web/package.json",
            sourceFiles: ["apps/web/value.ts"],
            tsconfigPaths: [],
            environments: ["javascript", "typescript"],
            dependencyDeclarations: [],
          },
        ],
      }),
      dispatch: dispatchChecks,
      adapters: [
        {
          id: "formatting",
          output: "legacy-check-result",
          inspect: async () => ({
            applies: true,
            executionClass: "lightweight",
            requiresBaseline: false,
            targets: [
              { id: "web-output", kind: "workspace", relativeRoot: "apps/web" },
            ],
          }),
          runLegacy: async () => {
            throw new Error("sensitive engine error");
          },
        },
      ],
    });

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: deps,
    });

    expect(report).toMatchObject({
      outcome: "incomplete",
      exitCode: 2,
      checks: [
        { checkId: "formatting", target: "web-output", status: "incomplete" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("sensitive");
    expect(JSON.stringify(report)).not.toContain("policy");
  });

  it("runs the complete pipeline and cleans before returning an immutable report", async () => {
    const calls: string[] = [];
    const privateConfigurationMarker = "private-config-marker-9283";
    const reportConfig = resolveConfig(
      {
        schemaVersion: 1,
        profile: "recommended",
        checks: {
          lint: {
            rules: {
              "no-console": ["warn", { allow: [privateConfigurationMarker] }],
            },
          },
        },
      },
      "/repo/private-zedbee-config.jsonc",
    );

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies(calls, {
        loadConfig: async () => {
          calls.push("load config");
          return reportConfig;
        },
      }),
    });
    calls.push("return report");

    expect(calls).toEqual([
      "load config",
      "read staged changes",
      "build snapshots",
      "inspect /tmp/baseline",
      "inspect /tmp/target",
      "dispatch checks",
      "evaluate policy",
      "clean snapshots",
      "return report",
    ]);
    expect(report).toMatchObject({
      schemaVersion: 1,
      outcome: "pass",
      exitCode: 0,
      repositoryRoot: "/repo",
      baseline: "HEAD",
      target: "index",
      startedAt: "2026-08-15T00:00:00.000Z",
      durationMs: 1,
      summary: { passed: 1 },
      checks: [passing],
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.checks)).toBe(true);
    expect(Object.isFrozen(report.summary.findings)).toBe(true);
    const rawKeys: string[] = [];
    const pending: object[] = [report];
    const visited = new Set<object>();
    while (pending.length > 0) {
      const value = pending.pop()!;
      if (visited.has(value)) continue;
      visited.add(value);
      for (const key of Reflect.ownKeys(value)) {
        expect(typeof key).toBe("string");
        if (typeof key !== "string") continue;
        rawKeys.push(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        expect("value" in descriptor).toBe(true);
        if (!("value" in descriptor)) continue;
        expect(typeof descriptor.value).not.toBe("function");
        if (typeof descriptor.value === "object" && descriptor.value !== null) {
          pending.push(descriptor.value);
        }
      }
    }
    for (const privateKey of [
      "config",
      "configPath",
      "configurationOrigins",
      "plugins",
      "rules",
      "settings",
    ]) {
      expect(rawKeys).not.toContain(privateKey);
    }
    expect(Object.keys(JSON.parse(JSON.stringify(report)))).toEqual([
      "schemaVersion",
      "outcome",
      "exitCode",
      "repositoryRoot",
      "baseline",
      "target",
      "stagedFileCount",
      "startedAt",
      "durationMs",
      "networkDisclosures",
      "presentationPolicy",
      "summary",
      "checks",
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(privateConfigurationMarker);
    expect(serialized).not.toContain("private-zedbee-config.jsonc");
    expect(serialized).not.toMatch(
      /configurationOrigins|configPath|"rules"|"settings"|"plugins?"|"functions?"/u,
    );
  });

  it.each([
    {
      name: "documented defaults",
      reporting: undefined,
      reportingSurface: "text" as const,
      sourceExcerpts: undefined,
      expected: {
        terminalFindingLimit: 25,
        temporaryReportMaxAge: "24h",
        persistSourceExcerpts: false,
        agentGuidance: EMPTY_AGENT_GUIDANCE,
      },
    },
    {
      name: "always policy",
      reporting: {
        sourceExcerpts: "always" as const,
        terminalFindingLimit: "all" as const,
        temporaryReportMaxAge: "7d",
      },
      reportingSurface: "json" as const,
      sourceExcerpts: undefined,
      expected: {
        terminalFindingLimit: "all" as const,
        temporaryReportMaxAge: "7d",
        persistSourceExcerpts: true,
        agentGuidance: EMPTY_AGENT_GUIDANCE,
      },
    },
    {
      name: "--include-source over interactive",
      reporting: {
        sourceExcerpts: "interactive" as const,
        terminalFindingLimit: 11,
        temporaryReportMaxAge: "3d",
      },
      reportingSurface: "text" as const,
      sourceExcerpts: "include" as const,
      expected: {
        terminalFindingLimit: 11,
        temporaryReportMaxAge: "3d",
        persistSourceExcerpts: true,
        agentGuidance: EMPTY_AGENT_GUIDANCE,
      },
    },
    {
      name: "--no-source over always",
      reporting: {
        sourceExcerpts: "always" as const,
        terminalFindingLimit: 7,
        temporaryReportMaxAge: "2d",
      },
      reportingSurface: "ink" as const,
      sourceExcerpts: "exclude" as const,
      expected: {
        terminalFindingLimit: 7,
        temporaryReportMaxAge: "2d",
        persistSourceExcerpts: false,
        agentGuidance: EMPTY_AGENT_GUIDANCE,
      },
    },
  ])(
    "retains the resolved presentation policy for $name",
    async ({ reporting, reportingSurface, sourceExcerpts, expected }) => {
      const resolved = resolveConfig({
        schemaVersion: 1,
        profile: "recommended",
        ...(reporting === undefined ? {} : { reporting }),
      });
      const report = await runScan({
        repositoryRoot: "/repo",
        reportingSurface,
        ...(sourceExcerpts === undefined ? {} : { sourceExcerpts }),
        dependencies: dependencies([], {
          loadConfig: async () => resolved,
        }),
      });

      expect(report.presentationPolicy).toEqual(expected);
      expect(Object.isFrozen(report.presentationPolicy)).toBe(true);
    },
  );

  it("retains resolved presentation policy on a fail-closed report", async () => {
    const resolved = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      reporting: {
        sourceExcerpts: "always",
        terminalFindingLimit: "all",
        temporaryReportMaxAge: "8d",
      },
    });
    const report = await runScan({
      repositoryRoot: "/repo",
      reportingSurface: "sarif",
      dependencies: dependencies([], {
        loadConfig: async () => resolved,
        dispatch: async () => {
          throw new Error("sensitive adapter failure");
        },
      }),
    });

    expect(report).toMatchObject({ outcome: "incomplete", exitCode: 2 });
    expect(report.presentationPolicy).toEqual({
      terminalFindingLimit: "all",
      temporaryReportMaxAge: "8d",
      persistSourceExcerpts: true,
      agentGuidance: EMPTY_AGENT_GUIDANCE,
    });
    expect(Object.isFrozen(report.presentationPolicy)).toBe(true);
  });

  it("enriches policy results before cleanup and keeps the summary aligned", async () => {
    const calls: string[] = [];
    const created = await mkdtemp(join(tmpdir(), "zedbee-snapshot-excerpts-"));
    const snapshotRoot = await realpath(created);
    const baselineDir = join(snapshotRoot, "baseline");
    const targetDir = join(snapshotRoot, "target");
    await mkdir(baselineDir);
    await mkdir(join(targetDir, "src"), { recursive: true });
    await writeFile(
      join(targetDir, "src/value.ts"),
      "one\ntwo\nthree\nexport const staged = true;\n",
    );
    onTestFinished(() => rm(snapshotRoot, { recursive: true, force: true }));

    const excerptConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: "error" },
      reporting: { sourceExcerpts: "interactive" },
    });
    const deps = dependencies(calls, {
      loadConfig: async () => {
        calls.push("load config");
        return excerptConfig;
      },
      buildSnapshots: async () => {
        calls.push("build snapshots");
        return {
          baselineDir,
          targetDir,
          baselineRef: "HEAD",
          unsupportedEntries: [],
          cleanup: async () => {
            calls.push("clean snapshots");
            await rm(snapshotRoot, { recursive: true });
          },
        };
      },
      dispatch: async () => {
        calls.push("dispatch checks");
        return [
          {
            result: {
              ...blocking,
              findings: [
                {
                  ...blocking.findings[0]!,
                  location: { file: "src/value.ts", startLine: 4 },
                },
              ],
            },
            policy: Object.freeze({ ...excerptConfig.checks.lint }),
          },
        ];
      },
      evaluate: (results, resolvedConfig) => {
        calls.push("evaluate policy");
        return evaluatePolicy(results, resolvedConfig);
      },
    });

    const report = await runScan({
      repositoryRoot: "/repo",
      reportingSurface: "ink",
      dependencies: deps,
    });

    const expectedExcerpt = {
      line: 4,
      text: "export const staged = true;",
      redacted: false,
      truncated: false,
    };
    expect(report.checks[0]?.findings[0]?.sourceExcerpt).toEqual(
      expectedExcerpt,
    );
    expect(report.summary.findings[0]?.sourceExcerpt).toEqual(expectedExcerpt);
    expect(calls.indexOf("evaluate policy")).toBeLessThan(
      calls.indexOf("clean snapshots"),
    );
  });

  it("keeps default interactive source live but strips it from an overflow report", async () => {
    const created = await mkdtemp(join(tmpdir(), "zedbee-live-excerpts-"));
    const snapshotRoot = await realpath(created);
    const baselineDir = join(snapshotRoot, "baseline");
    const targetDir = join(snapshotRoot, "target");
    await mkdir(baselineDir);
    await mkdir(join(targetDir, "src"), { recursive: true });
    await writeFile(
      join(targetDir, "src/value.ts"),
      "one\ntwo\nthree\nexport const staged = true;\n",
    );
    onTestFinished(() => rm(snapshotRoot, { recursive: true, force: true }));

    const interactiveConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: "error" },
      reporting: { sourceExcerpts: "interactive" },
    });
    const baseFinding = blocking.findings[0]!;
    const deps = dependencies([], {
      loadConfig: async () => interactiveConfig,
      buildSnapshots: async () => ({
        baselineDir,
        targetDir,
        baselineRef: "HEAD",
        unsupportedEntries: [],
        cleanup: async () => undefined,
      }),
      dispatch: async () => [
        {
          result: {
            ...blocking,
            findings: Array.from({ length: 26 }, (_, index) => ({
              ...baseFinding,
              id: `lint-${index}`,
              location: { file: "src/value.ts", startLine: 4 },
            })),
          },
          policy: Object.freeze({ ...interactiveConfig.checks.lint }),
        },
      ],
    });
    const report = await runScan({
      repositoryRoot: "/repo",
      reportingSurface: "ink",
      dependencies: deps,
    });
    let request: TemporaryReportRequest | undefined;
    const store: TemporaryReportStore = {
      async maintain(value) {
        request = value;
        return { reportPath: "/tmp/zedbee/complete.json", warnings: [] };
      },
    };

    const presentation = await prepareTerminalPresentation(report, {
      requestedFormat: "auto",
      selectedFormat: "ink",
      store,
    });

    expect(report.summary.findings[0]?.sourceExcerpt?.text).toBe(
      "export const staged = true;",
    );
    expect(report.presentationPolicy.persistSourceExcerpts).toBe(false);
    expect(request?.json).not.toContain("export const staged = true;");
    expect(presentation).toMatchObject({
      abbreviated: true,
      totalFindingCount: 26,
      reportPath: "/tmp/zedbee/complete.json",
    });
  });

  it("omits adapter excerpts from library reports without a surface", async () => {
    const resultWithExcerpt: CheckResult = {
      ...blocking,
      findings: [
        {
          ...blocking.findings[0]!,
          sourceExcerpt: {
            line: 1,
            text: "adapter-controlled source",
            redacted: false,
            truncated: false,
          },
        },
      ],
    };
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        dispatch: async () => [
          {
            result: resultWithExcerpt,
            policy: Object.freeze({ ...config.checks.lint }),
          },
        ],
      }),
    });

    expect(report.checks[0]?.findings[0]?.sourceExcerpt).toBeUndefined();
    expect(report.summary.findings[0]?.sourceExcerpt).toBeUndefined();
  });

  it("returns a successful no-op without creating snapshots for an empty index", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, {
      readChangeSet: async () => {
        calls.push("read staged changes");
        return emptyChangeSet;
      },
      baselineForEmptyChange: async () => "HEAD",
      buildSnapshots: async () => {
        throw new Error("snapshots must not be built");
      },
      dispatch: async () => {
        throw new Error("checks must not be dispatched");
      },
    });

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: deps,
    });

    expect(calls).toEqual(["load config", "read staged changes"]);
    expect(report).toMatchObject({
      outcome: "pass",
      exitCode: 0,
      baseline: "HEAD",
      stagedFileCount: 0,
      checks: [],
      summary: { passed: 0, warnings: 0, failed: 0, incomplete: 0 },
    });
  });

  it.each(["dispatch", "policy"] as const)(
    "cleans snapshots when %s fails",
    async (failurePoint) => {
      const calls: string[] = [];
      const deps = dependencies(calls, {
        ...(failurePoint === "dispatch"
          ? {
              dispatch: async () => {
                calls.push("dispatch checks");
                throw new Error("sensitive adapter failure");
              },
            }
          : {
              evaluate: () => {
                calls.push("evaluate policy");
                throw new Error("sensitive policy failure");
              },
            }),
      });

      const report = await runScan({
        repositoryRoot: "/repo",
        dependencies: deps,
      });

      expect(calls.at(-1)).toBe("clean snapshots");
      const expectedFailure =
        failurePoint === "dispatch"
          ? {
              code: "CHECK_DISPATCH_FAILED",
              message: "Zedbee could not dispatch the configured checks.",
            }
          : {
              code: "POLICY_EVALUATION_FAILED",
              message: "Zedbee could not evaluate the scan policy.",
            };
      expect(report).toMatchObject({
        outcome: "incomplete",
        exitCode: 2,
        checks: [
          {
            checkId: "zedbee",
            status: "incomplete",
            error: expectedFailure,
          },
        ],
      });
      expect(JSON.stringify(report)).not.toContain("sensitive");
    },
  );

  it("returns one sanitized incomplete result and cleans snapshots when inspection fails", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, {
      inspectRepository: async (snapshotRoot) => {
        calls.push(`inspect ${snapshotRoot}`);
        throw new Error(`sensitive inspection failure in ${snapshotRoot}`);
      },
      dispatch: async () => {
        throw new Error("checks must not be dispatched");
      },
    });

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: deps,
    });

    expect(calls).toEqual([
      "load config",
      "read staged changes",
      "build snapshots",
      "inspect /tmp/baseline",
      "clean snapshots",
    ]);
    expect(report).toMatchObject({
      outcome: "incomplete",
      exitCode: 2,
      checks: [
        {
          checkId: "zedbee",
          status: "incomplete",
          error: {
            code: "BASELINE_INSPECTION_FAILED",
            message: "Zedbee could not inspect the baseline snapshot.",
          },
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("sensitive");
    expect(JSON.stringify(report)).not.toContain("/tmp/baseline");
  });

  it("propagates an abort even when snapshot cleanup also fails", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const deps = dependencies(calls, {
      buildSnapshots: async () => ({
        baselineDir: "/tmp/baseline",
        targetDir: "/tmp/target",
        baselineRef: "HEAD",
        unsupportedEntries: [],
        cleanup: async () => {
          calls.push("clean snapshots");
          throw new Error("sensitive cleanup failure");
        },
      }),
      dispatch: async () => {
        calls.push("dispatch checks");
        controller.abort();
        throw new Error("aborted");
      },
    });

    await expect(
      runScan({
        repositoryRoot: "/repo",
        signal: controller.signal,
        dependencies: deps,
      }),
    ).rejects.toThrow("aborted");
    expect(calls.at(-1)).toBe("clean snapshots");
  });

  it("returns incomplete when staged change discovery fails before snapshots exist", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, {
      readChangeSet: async () => {
        calls.push("read staged changes");
        throw new Error("sensitive diff failure");
      },
    });

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: deps,
    });

    expect(report).toMatchObject({ outcome: "incomplete", exitCode: 2 });
    expect(calls).toEqual(["load config", "read staged changes"]);
    expect(JSON.stringify(report)).not.toContain("sensitive");
  });
});
