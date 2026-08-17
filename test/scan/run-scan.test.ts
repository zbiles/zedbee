import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { CheckResult } from "../../src/core/types.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { ConfigError } from "../../src/config/load-config.js";
import type { GitClient } from "../../src/git/client.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import type { SnapshotPair } from "../../src/git/snapshot.js";
import { SnapshotError } from "../../src/git/snapshot.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import {
  DEFAULT_CHECK_ADAPTERS,
  runScan,
  type RunScanDependencies,
} from "../../src/scan/run-scan.js";
import type { ScanEvent } from "../../src/checks/events.js";

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

describe("runScan", () => {
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
          services: ["api.osv.dev", "api.deps.dev"],
          metadata: ["package names", "versions"],
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
        services: ["api.osv.dev", "api.deps.dev"],
        metadata: ["package names", "versions"],
      },
    ]);
    expect(Object.isFrozen(report.networkDisclosures)).toBe(true);
  });

  it("fails closed for LFS but passes an intent-only index without dispatching", async () => {
    let dispatchCalls = 0;
    const lfsReport = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
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
    expect(JSON.stringify(report)).not.toContain("private-token-123");
  });

  it("reports the repository-relative path for a staged Git LFS pointer", async () => {
    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies([], {
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
    expect(JSON.stringify({ completedEvent, report })).not.toMatch(
      /policy|unexpected/i,
    );
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
          },
          {
            relativeRoot: "apps/web",
            manifestPath: "apps/web/package.json",
            sourceFiles: ["apps/web/value.ts"],
            tsconfigPaths: ["apps/web/tsconfig.json"],
            environments: ["javascript", "typescript"],
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

    const report = await runScan({
      repositoryRoot: "/repo",
      dependencies: dependencies(calls),
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
