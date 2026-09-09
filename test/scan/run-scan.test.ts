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
import {
  ConfigError,
  loadConfigFromCommit,
} from "../../src/config/load-config.js";
import { GitClient, type GitOutput } from "../../src/git/client.js";
import { GitCommandError } from "../../src/git/errors.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import {
  BaseComparisonError,
  resolveBaseComparison,
  type BaseComparison,
  type BaseComparisonErrorCode,
} from "../../src/git/base-comparison.js";
import type { SnapshotPair } from "../../src/git/snapshot.js";
import {
  SnapshotConstructionCleanupError,
  SnapshotError,
} from "../../src/git/snapshot.js";
import { validateSnapshotPath } from "../../src/git/snapshot-path.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import {
  DEFAULT_CHECK_ADAPTERS,
  runScan as runScanProduct,
  type RunScanDependencies,
} from "../../src/scan/run-scan.js";
import { createLocalAnalyzerExecutor } from "../../src/checks/runner/executor.js";

// These reporting/preparation fixtures inject synthetic snapshot paths. Their
// execution boundary deliberately skips source capture; real source epochs and
// executor ownership are covered by analysis-session and API lifecycle tests.
async function runScan(options: Parameters<typeof runScanProduct>[0]) {
  const executor = createLocalAnalyzerExecutor();
  try {
    return await runScanProduct({
      ...options,
      executor: {
        openSession: () => executor.openSession(),
        close: () => executor.close(),
      },
    });
  } finally {
    await executor.close();
  }
}
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

function configWithLintEnabledOnlyFor(
  files: readonly string[],
): ResolvedConfig {
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
    targetRef: "index",
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
    targetRef: "index",
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
    resolveBaseComparison: async () => {
      throw new Error("base resolution must be explicitly configured");
    },
    loadIndexConfig: async () => {
      calls.push("load config");
      return config;
    },
    loadCommitConfig: async () => {
      throw new Error("commit config must be explicitly configured");
    },
    createGitClient: () => ({}) as GitClient,
    readIndexChangeSet: async () => {
      calls.push("read staged changes");
      return nonEmptyChangeSet;
    },
    readCommitChangeSet: async () => {
      throw new Error("commit changes must be explicitly configured");
    },
    buildIndexSnapshots: async () => {
      calls.push("build snapshots");
      return snapshots;
    },
    buildCommitSnapshots: async () => {
      throw new Error("commit snapshots must be explicitly configured");
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
  it("uses only index source operations when no base is requested", async () => {
    const calls: string[] = [];
    const indexSnapshots: SnapshotPair = {
      baselineDir: "/tmp/baseline",
      targetDir: "/tmp/target",
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
      cleanup: async () => {
        calls.push("clean snapshots");
      },
    };
    const deps = {
      ...dependencies(calls),
      resolveBaseComparison: async () => {
        throw new Error("base resolution must not be called");
      },
      loadIndexConfig: async () => {
        calls.push("load index config");
        return config;
      },
      loadCommitConfig: async () => {
        throw new Error("commit config must not be called");
      },
      readIndexChangeSet: async () => {
        calls.push("read index changes");
        return nonEmptyChangeSet;
      },
      readCommitChangeSet: async () => {
        throw new Error("commit changes must not be called");
      },
      buildIndexSnapshots: async () => {
        calls.push("build index snapshots");
        return indexSnapshots;
      },
      buildCommitSnapshots: async () => {
        throw new Error("commit snapshots must not be called");
      },
    } satisfies RunScanDependencies;

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: deps,
    });

    expect(report).toMatchObject({
      outcome: "pass",
      mode: "index",
      baseline: "HEAD",
      target: "index",
      changedFileCount: 1,
    });
    expect(calls).toEqual([
      "load index config",
      "read index changes",
      "build index snapshots",
      "inspect /tmp/baseline",
      "inspect /tmp/target",
      "dispatch checks",
      "evaluate policy",
      "clean snapshots",
    ]);
  });

  it("resolves a base once and passes its commit IDs to every committed source operation", async () => {
    const baselineCommit = "1111111111111111111111111111111111111111";
    const targetCommit = "2222222222222222222222222222222222222222";
    const comparison: BaseComparison = {
      requestedBase: "origin/main",
      baselineCommit,
      targetCommit,
    };
    const calls: string[] = [];
    const bootstrapGit = { kind: "bootstrap" } as unknown as GitClient;
    const configuredGit = { kind: "configured" } as unknown as GitClient;
    let gitCreations = 0;
    const commitSnapshots: SnapshotPair = {
      baselineDir: "/tmp/baseline",
      targetDir: "/tmp/target",
      baselineRef: baselineCommit,
      targetRef: targetCommit,
      unsupportedEntries: [],
      cleanup: async () => {
        calls.push("clean snapshots");
      },
    };
    const deps = {
      ...dependencies(calls),
      createGitClient: () =>
        gitCreations++ === 0 ? bootstrapGit : configuredGit,
      resolveBaseComparison: async (
        git: GitClient,
        requestedBase: string,
        signal?: AbortSignal,
      ) => {
        expect(git).toBe(bootstrapGit);
        expect(requestedBase).toBe("origin/main");
        expect(signal).toBeUndefined();
        calls.push("resolve base");
        return comparison;
      },
      loadIndexConfig: async () => {
        throw new Error("index config must not be called");
      },
      loadCommitConfig: async (
        root: string,
        git: GitClient,
        commit: string,
        configPath?: string,
        signal?: AbortSignal,
      ) => {
        expect([root, git, commit, configPath, signal]).toEqual([
          "/repo",
          bootstrapGit,
          targetCommit,
          undefined,
          undefined,
        ]);
        calls.push("load commit config");
        return config;
      },
      readIndexChangeSet: async () => {
        throw new Error("index changes must not be called");
      },
      readCommitChangeSet: async (
        git: GitClient,
        baseline: string,
        target: string,
      ) => {
        expect([git, baseline, target]).toEqual([
          configuredGit,
          baselineCommit,
          targetCommit,
        ]);
        calls.push("read commit changes");
        return nonEmptyChangeSet;
      },
      buildIndexSnapshots: async () => {
        throw new Error("index snapshots must not be called");
      },
      buildCommitSnapshots: async (
        root: string,
        git: GitClient,
        baseline: string,
        target: string,
      ) => {
        expect([root, git, baseline, target]).toEqual([
          "/repo",
          configuredGit,
          baselineCommit,
          targetCommit,
        ]);
        calls.push("build commit snapshots");
        return commitSnapshots;
      },
    } satisfies RunScanDependencies;

    const report = await runScan({
      repositoryRoot: "/repo",
      baseRef: "origin/main",
      dependencies: deps,
    });

    expect(report).toMatchObject({
      mode: "base",
      baseline: baselineCommit,
      target: targetCommit,
      requestedBase: "origin/main",
      changedFileCount: 1,
    });
    expect(calls).toEqual([
      "resolve base",
      "load commit config",
      "read commit changes",
      "build commit snapshots",
      "inspect /tmp/baseline",
      "inspect /tmp/target",
      "dispatch checks",
      "evaluate policy",
      "clean snapshots",
    ]);
  });

  it("reports base resolution errors before configuration or check execution", async () => {
    const calls: string[] = [];
    const deps = {
      ...dependencies(calls),
      resolveBaseComparison: async () => {
        calls.push("resolve base");
        throw new BaseComparisonError(
          "BASE_REF_UNAVAILABLE",
          "private ref details",
        );
      },
      loadIndexConfig: async () => {
        throw new Error("index config must not be called");
      },
      loadCommitConfig: async () => {
        calls.push("load commit config");
        return config;
      },
      readIndexChangeSet: async () => {
        throw new Error("index changes must not be called");
      },
      readCommitChangeSet: async () => {
        calls.push("read commit changes");
        return nonEmptyChangeSet;
      },
      buildIndexSnapshots: async () => {
        throw new Error("index snapshots must not be called");
      },
      buildCommitSnapshots: async () => {
        calls.push("build commit snapshots");
        throw new Error("snapshots must not be built");
      },
    } satisfies RunScanDependencies;

    const report = await runScan({
      repositoryRoot: "/repo",
      baseRef: "missing-base",
      dependencies: deps,
    });

    expect(calls).toEqual(["resolve base"]);
    expect(report).toMatchObject({
      outcome: "incomplete",
      exitCode: 2,
      mode: "base",
      baseline: null,
      target: null,
      requestedBase: "missing-base",
      changedFileCount: null,
      checks: [{ error: { code: "BASE_REF_UNAVAILABLE" } }],
    });
    expect(JSON.stringify(report)).not.toContain("private ref details");
  });

  it.each<{
    code: BaseComparisonErrorCode;
    remediation: string;
  }>([
    {
      code: "BASE_REF_INVALID",
      remediation:
        "Choose a non-empty display-safe base ref that does not begin with '-', then retry.",
    },
    {
      code: "BASE_REF_UNAVAILABLE",
      remediation:
        "Fetch the requested base ref or choose one available locally, then retry.",
    },
    {
      code: "TARGET_COMMIT_UNAVAILABLE",
      remediation: "Check out or create a valid target commit, then retry.",
    },
    {
      code: "MERGE_BASE_UNAVAILABLE",
      remediation:
        "Fetch enough local history for both revisions or choose a base with shared history, then retry.",
    },
    {
      code: "MERGE_BASE_AMBIGUOUS",
      remediation: "Choose a base with one unambiguous merge base, then retry.",
    },
    {
      code: "REVISION_OUTPUT_INVALID",
      remediation:
        "Verify the local Git repository and Git executable, then retry.",
    },
  ])(
    "preserves sanitized base resolution code $code",
    async ({ code, remediation }) => {
      const report = await runScan({
        repositoryRoot: "/repo",
        baseRef: "origin/main",
        dependencies: dependencies([], {
          resolveBaseComparison: async () => {
            throw new BaseComparisonError(code, "private resolver details");
          },
        }),
      });

      expect(report).toMatchObject({
        outcome: "incomplete",
        mode: "base",
        requestedBase: "origin/main",
        checks: [{ error: { code, remediation } }],
      });
      expect(JSON.stringify(report)).not.toContain("private resolver details");
    },
  );

  it.each([
    `topic\u202Ehidden`,
    `topic\u2028hidden`,
    `topic\u2029hidden`,
    "x".repeat(257),
  ])(
    "never copies invalid requested-base text into an incomplete report",
    async (baseRef) => {
      const report = await runScan({
        repositoryRoot: "/repo",
        baseRef,
        dependencies: dependencies([], {
          resolveBaseComparison: async () => {
            throw new BaseComparisonError(
              "BASE_REF_INVALID",
              "invalid requested base",
            );
          },
        }),
      });

      expect(report).toMatchObject({
        outcome: "incomplete",
        mode: "base",
        baseline: null,
        target: null,
      });
      expect(report).not.toHaveProperty("requestedBase");
      expect(JSON.stringify(report)).not.toContain(baseRef);
    },
  );

  it("returns explicit resolved identities for an empty base comparison", async () => {
    const baselineCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const targetCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const calls: string[] = [];
    const deps = {
      ...dependencies(calls),
      resolveBaseComparison: async () => ({
        requestedBase: "main",
        baselineCommit,
        targetCommit,
      }),
      loadIndexConfig: async () => {
        throw new Error("index config must not be called");
      },
      loadCommitConfig: async () => {
        calls.push("load commit config");
        return config;
      },
      readIndexChangeSet: async () => {
        throw new Error("index changes must not be called");
      },
      readCommitChangeSet: async () => {
        calls.push("read commit changes");
        return emptyChangeSet;
      },
      buildIndexSnapshots: async () => {
        throw new Error("index snapshots must not be called");
      },
      buildCommitSnapshots: async () => {
        throw new Error("commit snapshots must not be built");
      },
    } satisfies RunScanDependencies;

    const report = await runScan({
      repositoryRoot: "/repo",
      baseRef: "main",
      dependencies: deps,
    });

    expect(calls).toEqual(["load commit config", "read commit changes"]);
    expect(report).toMatchObject({
      outcome: "pass",
      exitCode: 0,
      mode: "base",
      baseline: baselineCommit,
      target: targetCommit,
      requestedBase: "main",
      changedFileCount: 0,
      checks: [],
    });
  });

  it("propagates its abort signal to empty-index baseline resolution", async () => {
    const controller = new AbortController();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const deps = dependencies([], {
      readIndexChangeSet: async () => emptyChangeSet,
      baselineForEmptyChange: async (_git, signal?: AbortSignal) => {
        receivedSignal = signal;
        resolveStarted?.();
        return new Promise<"HEAD" | null>((_resolve, reject) => {
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

    await expect(pending).rejects.toMatchObject({ code: "GIT_ABORTED" });
    expect(receivedSignal).toBe(controller.signal);
  });

  it("maps a bounded Git output failure to a sanitized incomplete report", async () => {
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        readIndexChangeSet: async () => {
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

  it.each([
    { timeout: undefined, noTimeout: false, expectedHardTimeoutMs: 30_000 },
    { timeout: "7ms", noTimeout: false, expectedHardTimeoutMs: 7 },
    { timeout: "7ms", noTimeout: true, expectedHardTimeoutMs: undefined },
  ])(
    "constructs the bootstrap Git client with bounded CLI policy %#",
    async ({ timeout, noTimeout, expectedHardTimeoutMs }) => {
      let bootstrapPolicy:
        ConstructorParameters<typeof GitClient>[1] | undefined;
      await runScan({
        repositoryRoot: "/repo",
        baseRef: "main",
        ...(timeout === undefined ? {} : { timeout }),
        ...(noTimeout ? { noTimeout: true } : {}),
        dependencies: dependencies([], {
          createGitClient: (_root, options) => {
            bootstrapPolicy = options;
            return {} as GitClient;
          },
          resolveBaseComparison: async () => {
            throw new Error("stop after bootstrap policy capture");
          },
        }),
      });

      expect(bootstrapPolicy?.resourcePolicy).toMatchObject({
        gitHardTimeoutMs: expectedHardTimeoutMs,
        gitOutputLimitBytes: 64 * 1024 * 1024,
      });
    },
  );

  it("applies the CLI timeout while resolving the requested base", async () => {
    const report = await runScan({
      repositoryRoot: "/repo",
      baseRef: "main",
      timeout: "5ms",
      dependencies: dependencies([], {
        createGitClient: (root, options) =>
          new GitClient(root, {
            ...options,
            runCommand: delayedGitCommand(20),
          }),
        resolveBaseComparison: async (git) => {
          await git.run(["rev-parse", "main"]);
          throw new Error("resolver unexpectedly completed");
        },
      }),
    });

    expect(report).toMatchObject({
      outcome: "incomplete",
      mode: "base",
      checks: [{ error: { code: "GIT_HARD_TIMEOUT" } }],
    });
  });

  it("preserves a CLI timeout from a hanging committed-config blob read", async () => {
    const baselineCommit = "1".repeat(40);
    const targetCommit = "2".repeat(40);
    const configBlob = "3".repeat(40);
    const delayed = delayedGitCommand(20);
    const report = await runScan({
      repositoryRoot: "/repo",
      baseRef: "main",
      timeout: "5ms",
      dependencies: dependencies([], {
        createGitClient: (root, options) =>
          new GitClient(root, {
            ...options,
            async runCommand(args, runOptions) {
              if (args[0] === "cat-file") return delayed(args, runOptions);
              if (args[0] === "merge-base") {
                return {
                  stdout: `${baselineCommit}\n`,
                  stderr: "",
                  exitCode: 0,
                };
              }
              if (args[0] === "ls-tree") {
                return {
                  stdout: `100644 blob ${configBlob}\t.zedbeerc.jsonc\0`,
                  stderr: "",
                  exitCode: 0,
                };
              }
              return {
                stdout: `${args.at(-1)?.startsWith("main") ? baselineCommit : targetCommit}\n`,
                stderr: "",
                exitCode: 0,
              };
            },
          }),
        resolveBaseComparison,
        loadCommitConfig: loadConfigFromCommit,
      }),
    });

    expect(report).toMatchObject({
      outcome: "incomplete",
      mode: "base",
      baseline: baselineCommit,
      target: targetCommit,
      requestedBase: "main",
      checks: [{ error: { code: "GIT_HARD_TIMEOUT" } }],
    });
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
        loadIndexConfig: async () => softTimeoutConfig,
        createGitClient: (root, options) =>
          new GitClient(root, {
            ...options,
            runCommand: delayedGitCommand(20),
          }),
        readIndexChangeSet: async (git, signal) => {
          await git.run(["status"], signal === undefined ? {} : { signal });
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
        loadIndexConfig: async () => hardTimeoutConfig,
        createGitClient: (root, options) =>
          new GitClient(root, {
            ...options,
            runCommand: delayedGitCommand(20),
          }),
        readIndexChangeSet: async (git, signal) => {
          await git.run(["status"], signal === undefined ? {} : { signal });
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
        loadIndexConfig: async () => hardTimeoutConfig,
        createGitClient: (root, options) =>
          new GitClient(root, {
            ...options,
            runCommand: delayedGitCommand(20),
          }),
        readIndexChangeSet: async (git, signal) => {
          await git.run(["status"], signal === undefined ? {} : { signal });
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
      readIndexChangeSet: async (_git, signal?: AbortSignal) => {
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

    await expect(pending).rejects.toMatchObject({ code: "GIT_ABORTED" });
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
      buildIndexSnapshots: async (
        _repositoryRoot,
        _git,
        signal?: AbortSignal,
      ) => {
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

    await expect(pending).rejects.toMatchObject({ code: "GIT_ABORTED" });
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
      buildIndexSnapshots: async () => ({
        baselineDir: "/tmp/baseline",
        targetDir: "/tmp/target",
        baselineRef: "HEAD",
        targetRef: "index",
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
      unsupportedEntryFailures(
        [entries[0]],
        changedPaths,
        policyForFile,
        "index",
      ),
    ).toEqual([]);
    expect(
      unsupportedEntryFailures(entries, changedPaths, policyForFile, "index"),
    ).toMatchObject([
      { code: "UNSUPPORTED_BINARY_INPUT", path: "src/other.ts" },
    ]);
  });

  it("uses source-specific unsupported-input remediation", () => {
    const changeSet = addedChangeSet("src/binary.ts");
    const changedPaths = new Set(changeSet.files.keys());
    const policyForFile = createFilePolicyResolver(config, changeSet);
    const entries = [{ path: "src/binary.ts", kind: "binary" }] as const;

    const [indexFailure] = unsupportedEntryFailures(
      entries,
      changedPaths,
      policyForFile,
      "index",
    );
    const [baseFailure] = unsupportedEntryFailures(
      entries,
      changedPaths,
      policyForFile,
      "base",
    );

    expect(indexFailure).toMatchObject({
      message:
        "Zedbee cannot analyze this staged binary file with the enabled checks.",
      remediation:
        "Stage valid text at this path or remove it from the staged change, then rerun the scan.",
    });
    expect(baseFailure).toMatchObject({
      message:
        "Zedbee cannot analyze this binary file in the committed target with the enabled checks.",
      remediation:
        "Commit valid text at this path or remove it from the committed target, then rerun the scan.",
    });
    expect(`${baseFailure?.message} ${baseFailure?.remediation}`).not.toMatch(
      /staged|Git index|stage it/iu,
    );
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
        readIndexChangeSet: async () => addedChangeSet("asset.dat"),
        buildIndexSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          targetRef: "index",
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
        readIndexChangeSet: async () => emptyChangeSet,
        buildIndexSnapshots: async () => {
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
      changedFileCount: 0,
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
        readIndexChangeSet: async () => ({
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
        buildIndexSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          targetRef: "index",
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
        buildIndexSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          targetRef: "index",
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

  it("allows an explicitly excluded unsupported path to proceed", async () => {
    const configured = resolveConfig({
      schemaVersion: 1,
      profile: "fast",
      checks: {
        formatting: "error",
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
      pathExclusions: [
        {
          files: ["generated/**"],
          checks: ["formatting"],
          reason: "Generated files are intentionally not formatted.",
        },
      ],
    });
    let dispatchCalls = 0;
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        loadIndexConfig: async () => configured,
        readIndexChangeSet: async () => addedChangeSet("generated/file.js"),
        buildIndexSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          targetRef: "index",
          unsupportedEntries: [
            { path: "generated/file.js", kind: "git-lfs-pointer" },
          ],
          cleanup: async () => undefined,
        }),
        dispatch: async () => {
          dispatchCalls += 1;
          return [
            {
              result: passing,
              policy: configured.checks.formatting,
            },
          ];
        },
      }),
    });

    expect(report).toMatchObject({ outcome: "pass", exitCode: 0 });
    expect(report.appliedPathExclusions).toEqual(configured.pathExclusions);
    expect(dispatchCalls).toBe(1);
  });

  it("records configured and applied path exclusions in scan reports", async () => {
    const configured = resolveConfig({
      schemaVersion: 1,
      profile: "fast",
      checks: {
        formatting: "error",
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
      pathExclusions: [
        {
          files: ["src/legacy/**", "./docs/**"],
          checks: ["formatting"],
          reason: "Legacy files are intentionally excluded.",
        },
      ],
    });
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        loadIndexConfig: async () => configured,
        readIndexChangeSet: async () =>
          addedChangeSet("src/legacy/file.ts", "src/current/file.ts"),
        buildIndexSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          targetRef: "index",
          unsupportedEntries: [],
          cleanup: async () => undefined,
        }),
        dispatch: async () => [
          {
            result: {
              ...passing,
              checkId: "formatting",
              status: "completed",
              durationMs: 1,
              findings: [],
            },
            policy: configured.checks.formatting,
          },
        ],
      }),
    });

    expect(report.configuredPathExclusions).toEqual([
      {
        files: ["src/legacy/**", "docs/**"],
        checks: ["formatting"],
        reason: "Legacy files are intentionally excluded.",
      },
    ]);
    expect(report.appliedPathExclusions).toEqual([
      {
        files: ["src/legacy/**", "docs/**"],
        checks: ["formatting"],
        reason: "Legacy files are intentionally excluded.",
      },
    ]);
    expect(report.summary.findings).toHaveLength(0);
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
        loadIndexConfig: async () => overrideConfig,
        readIndexChangeSet: async () => ({
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
        buildIndexSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          targetRef: "index",
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
        loadIndexConfig: async () => configWithLintEnabledOnlyFor(["src/**"]),
        readIndexChangeSet: async () => addedChangeSet("vendor/generated.ts"),
        buildIndexSnapshots: async () =>
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
        loadIndexConfig: async () => configWithLintEnabledOnlyFor(["src/**"]),
        readIndexChangeSet: async () => addedChangeSet("src/generated.ts"),
        buildIndexSnapshots: async () =>
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
        loadIndexConfig: async () => configWithLintEnabledOnlyFor(["src/**"]),
        readIndexChangeSet: async () => addedChangeSet("assets/photo.png"),
        buildIndexSnapshots: async () =>
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
        loadIndexConfig: async () => configWithLintEnabledOnlyFor(["src/**"]),
        readIndexChangeSet: async () => ({
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
        buildIndexSnapshots: async () =>
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
        loadIndexConfig: async () => configWithLintEnabledOnlyFor(["src/**"]),
        readIndexChangeSet: async () => ({
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
        buildIndexSnapshots: async () =>
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
        readIndexChangeSet: async () => ({
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
        buildIndexSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          targetRef: "index",
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
      loadIndexConfig: async () => cleanupConfig,
      buildIndexSnapshots: async () => ({
        baselineDir: join(canonicalSnapshotRoot, "baseline"),
        targetDir: join(canonicalSnapshotRoot, "target"),
        baselineRef: "HEAD",
        targetRef: "index",
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
        loadIndexConfig: async () => cleanupConfig,
        buildIndexSnapshots: async () => ({
          baselineDir: join(canonicalSnapshotRoot, "baseline"),
          targetDir: join(canonicalSnapshotRoot, "target"),
          baselineRef: "HEAD",
          targetRef: "index",
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
      const rawFailure = `RAW-CONSTRUCTION-${pathMode} /private/unsafe/path`;
      const created = await mkdtemp(
        join(tmpdir(), "zedbee-snapshot-run-scan-"),
      );
      const snapshotRoot = await validateSnapshotPath(await realpath(created));
      onTestFinished(async () => {
        await rm(snapshotRoot, { recursive: true, force: true });
      });
      const deps = dependencies([], {
        buildIndexSnapshots: async () => {
          throw new SnapshotConstructionCleanupError(
            new SnapshotError("SNAPSHOT_CONSTRUCTION_FAILED", rawFailure),
            pathMode === "validated" ? snapshotRoot : undefined,
          );
        },
      });

      const report = await runScan({
        repositoryRoot: "/repo",
        dependencies: deps,
      });

      expect(report).toMatchObject({
        outcome: "incomplete",
        exitCode: 2,
        changedFileCount: 1,
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
      }
    },
  );

  it("rejects with the abort reason when cancellation occurs during failed cleanup", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const abortReason = new DOMException("scan cancelled", "AbortError");
    const deps = dependencies(calls, {
      buildIndexSnapshots: async () => ({
        baselineDir: "/tmp/baseline",
        targetDir: "/tmp/target",
        baselineRef: "HEAD",
        targetRef: "index",
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
      buildIndexSnapshots: async () => ({
        baselineDir: "/tmp/baseline",
        targetDir: "/tmp/target",
        baselineRef: "HEAD",
        targetRef: "index",
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
            loadIndexConfig: async () => {
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
            readIndexChangeSet: async () => {
              throw new Error("private-token-123");
            },
          }
        : {}),
      ...(phase === "unresolved merge entries"
        ? {
            buildIndexSnapshots: async () => {
              throw new SnapshotError("UNRESOLVED_INDEX", "private-token-123");
            },
          }
        : {}),
      ...(phase === "invalid index path"
        ? {
            buildIndexSnapshots: async () => {
              throw new SnapshotError(
                "INVALID_INDEX_PATH",
                "private-token-123 /outside/repository",
              );
            },
          }
        : {}),
      ...(phase === "snapshot construction"
        ? {
            buildIndexSnapshots: async () => {
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

  it.each([
    {
      phase: "change discovery",
      code: "CHANGE_DISCOVERY_FAILED",
      message: "Zedbee could not read the committed changes.",
    },
    {
      phase: "invalid target path",
      code: "INVALID_INDEX_PATH",
      message: "Zedbee refused an invalid committed repository path.",
    },
    {
      phase: "snapshot construction",
      code: "SNAPSHOT_CONSTRUCTION_FAILED",
      message: "Zedbee could not construct the committed snapshots.",
    },
    {
      phase: "target inspection",
      code: "TARGET_INSPECTION_FAILED",
      message: "Zedbee could not inspect the committed target snapshot.",
    },
  ])(
    "uses committed-target language for base-mode $phase failures",
    async ({ phase, code, message }) => {
      const baselineCommit = "a".repeat(40);
      const targetCommit = "b".repeat(40);
      const commitSnapshots: SnapshotPair = {
        baselineDir: "/tmp/base-baseline",
        targetDir: "/tmp/base-target",
        baselineRef: baselineCommit,
        targetRef: targetCommit,
        unsupportedEntries: [],
        cleanup: async () => undefined,
      };
      const deps = dependencies([], {
        resolveBaseComparison: async () => ({
          requestedBase: "main",
          baselineCommit,
          targetCommit,
        }),
        loadCommitConfig: async () => config,
        readCommitChangeSet: async () => {
          if (phase === "change discovery") throw new Error("private");
          return nonEmptyChangeSet;
        },
        buildCommitSnapshots: async () => {
          if (phase === "invalid target path") {
            throw new SnapshotError("INVALID_INDEX_PATH", "private");
          }
          if (phase === "snapshot construction") throw new Error("private");
          return commitSnapshots;
        },
        inspectRepository: async (snapshotRoot) => {
          if (
            phase === "target inspection" &&
            snapshotRoot.endsWith("target")
          ) {
            throw new Error("private");
          }
          return {
            snapshotRoot,
            packageManager: "npm",
            lockfiles: [],
            workspaces: [],
          };
        },
      });

      const report = await runScan({
        repositoryRoot: "/repo",
        baseRef: "main",
        dependencies: deps,
      });
      const failure = report.checks[0]?.error;

      expect(failure).toMatchObject({ code, message });
      expect(`${failure?.message} ${failure?.remediation}`).not.toMatch(
        /staged|Git index|stage it/iu,
      );
    },
  );

  it("reports the repository-relative path for a staged Git LFS pointer", async () => {
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
        readIndexChangeSet: async () => addedChangeSet("assets/large.dat"),
        buildIndexSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: "HEAD",
          targetRef: "index",
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
        },
      },
    ]);
  });

  it("reports a committed Git LFS pointer without staged-only language", async () => {
    const baselineCommit = "a".repeat(40);
    const targetCommit = "b".repeat(40);
    const report = await runScan({
      repositoryRoot: "/repo",
      baseRef: "main",
      dependencies: dependencies([], {
        resolveBaseComparison: async () => ({
          requestedBase: "main",
          baselineCommit,
          targetCommit,
        }),
        loadCommitConfig: async () => config,
        readCommitChangeSet: async () => addedChangeSet("assets/large.dat"),
        buildCommitSnapshots: async () => ({
          baselineDir: "/tmp/baseline",
          targetDir: "/tmp/target",
          baselineRef: baselineCommit,
          targetRef: targetCommit,
          unsupportedEntries: [
            { path: "assets/large.dat", kind: "git-lfs-pointer" },
          ],
          cleanup: async () => undefined,
        }),
      }),
    });
    const failure = report.checks[0]?.error;

    expect(failure).toMatchObject({
      code: "GIT_LFS_POINTER",
      message:
        "Zedbee cannot inspect a Git LFS pointer in the committed target.",
      path: "assets/large.dat",
    });
    expect(`${failure?.message} ${failure?.remediation}`).not.toMatch(
      /staged|Git index|stage it/iu,
    );
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
      loadIndexConfig: async () => targetConfig,
      readIndexChangeSet: async () => addedChangeSet("apps/web/value.ts"),
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
      loadIndexConfig: async () => targetConfig,
      readIndexChangeSet: async () => addedChangeSet("apps/web/value.ts"),
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
        loadIndexConfig: async () => {
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
      "mode",
      "baseline",
      "target",
      "changedFileCount",
      "startedAt",
      "durationMs",
      "configuredPathExclusions",
      "appliedPathExclusions",
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
          loadIndexConfig: async () => resolved,
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
        loadIndexConfig: async () => resolved,
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
      loadIndexConfig: async () => {
        calls.push("load config");
        return excerptConfig;
      },
      buildIndexSnapshots: async () => {
        calls.push("build snapshots");
        return {
          baselineDir,
          targetDir,
          baselineRef: "HEAD",
          targetRef: "index",
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
      loadIndexConfig: async () => interactiveConfig,
      buildIndexSnapshots: async () => ({
        baselineDir,
        targetDir,
        baselineRef: "HEAD",
        targetRef: "index",
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
      readIndexChangeSet: async () => {
        calls.push("read staged changes");
        return emptyChangeSet;
      },
      baselineForEmptyChange: async () => "HEAD",
      buildIndexSnapshots: async () => {
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
      changedFileCount: 0,
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
      buildIndexSnapshots: async () => ({
        baselineDir: "/tmp/baseline",
        targetDir: "/tmp/target",
        baselineRef: "HEAD",
        targetRef: "index",
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
      readIndexChangeSet: async () => {
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
