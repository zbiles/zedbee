import { describe, expect, expectTypeOf, it, vi } from "vitest";
import * as engineIdentity from "../../src/checks/engine-identity.js";
import type { CheckResult, Finding } from "../../src/core/types.js";
import type { Observation } from "../../src/core/types.js";
import type { CheckId, ResolvedConfig } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import type { SnapshotPair } from "../../src/git/snapshot.js";
import type {
  CheckAdapter,
  CheckExecutionResult,
  CheckRunContext,
  CheckTarget,
  ExecutionClass,
  LegacyCheckResultAdapter,
  ObservationCheckAdapter,
} from "../../src/checks/adapter.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import type { ScanEvent } from "../../src/checks/events.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { CheckIncompleteError } from "../../src/checks/incomplete-error.js";
import {
  AnalyzerJobError,
  analyzerDiagnostic,
} from "../../src/checks/diagnostics.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";
import { prettierAdapter } from "../../src/checks/prettier/adapter.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import { lintAdapter } from "../../src/checks/eslint/lint-adapter.js";
import { duplicationAdapter } from "../../src/checks/duplication/adapter.js";
import type { CheckFixCandidate } from "../../src/fixes/types.js";

function createConfig(
  policies: Readonly<Record<string, "off" | "warn" | "error">>,
): ResolvedConfig {
  const resolved = resolveConfig({ schemaVersion: 1, profile: "fast" });
  return {
    ...resolved,
    checks: {
      ...resolved.checks,
      ...Object.fromEntries(
        Object.entries(policies).map(([id, severity]) => [
          id,
          { severity, when: "relevant" },
        ]),
      ),
    },
  };
}

function createContext(config: ResolvedConfig): CheckRunContext {
  const workspaceRoots = [
    ".",
    "apps/web",
    "packages/core",
    ...Array.from({ length: 5 }, (_, index) => `packages/${index}`),
  ];
  const sourcePath = (relativeRoot: string) =>
    relativeRoot === "." ? "fixture.ts" : `${relativeRoot}/fixture.ts`;
  const changedFiles = new Map(
    workspaceRoots.map((relativeRoot) => {
      const path = sourcePath(relativeRoot);
      return [
        path,
        {
          path,
          status: "modified" as const,
          addedRanges: [{ start: 1, end: 1 }],
        },
      ] as const;
    }),
  );
  const changeSet: ChangeSet = {
    files: changedFiles,
    isEmpty: false,
    containsAddedLine: (file, line) =>
      changedFiles.has(file.replaceAll("\\", "/")) && line === 1,
  };
  const snapshots: SnapshotPair = {
    baselineDir: "/tmp/baseline",
    targetDir: "/tmp/target",
    baselineRef: "HEAD",
    targetRef: "index",
    unsupportedEntries: [],
    cleanup: async () => undefined,
  };
  const baselineInspection: RepositoryInspection = {
    snapshotRoot: snapshots.baselineDir,
    packageManager: "npm",
    lockfiles: ["package-lock.json"],
    workspaces: workspaceRoots.map((relativeRoot) => ({
      relativeRoot,
      manifestPath:
        relativeRoot === "." ? "package.json" : `${relativeRoot}/package.json`,
      sourceFiles: [sourcePath(relativeRoot)],
      tsconfigPaths: [],
      environments: ["javascript"] as const,
      dependencyDeclarations: [],
    })),
  };
  return {
    repositoryRoot: "/repo",
    changeSet,
    config,
    snapshots,
    baselineInspection,
    targetInspection: {
      ...baselineInspection,
      snapshotRoot: snapshots.targetDir,
    },
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: config.checks.formatting,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

function completed(checkId: string): CheckResult {
  return {
    checkId,
    status: "completed",
    durationMs: 0,
    findings: [],
  };
}

function createAdapter(
  id: string,
  executionClass: ExecutionClass,
  run: LegacyCheckResultAdapter["runLegacy"] = async () => completed(id),
  targets: readonly CheckTarget[] = [
    { id: ".", kind: "repository", relativeRoot: "." },
  ],
): CheckAdapter {
  return {
    id,
    output: "observations",
    inspect: async () => ({
      applies: true,
      executionClass,
      requiresBaseline: false,
      targets,
    }),
    collect: async (context) => {
      await run(context);
      return {
        checkId: id,
        target: context.target,
        baselineObservations: [],
        targetObservations: [],
      };
    },
  };
}

function createLegacyAdapter(
  run: LegacyCheckResultAdapter["runLegacy"],
  targets: readonly CheckTarget[] = [
    { id: ".", kind: "repository", relativeRoot: "." },
  ],
): LegacyCheckResultAdapter {
  return {
    id: "formatting",
    output: "legacy-check-result",
    inspect: async () => ({
      applies: true,
      executionClass: "lightweight",
      requiresBaseline: false,
      targets,
    }),
    runLegacy: run,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const formattingObservation: Observation = {
  check: "formatting",
  rule: "fixture-rule",
  identity: "fixture:repository",
  severity: "error",
  message: "Fixture observation",
};

function observationAdapter(
  collect: ObservationCheckAdapter["collect"],
  requiresBaseline = true,
): ObservationCheckAdapter {
  return {
    id: "formatting",
    output: "observations",
    inspect: async () => ({
      applies: true,
      executionClass: "lightweight",
      requiresBaseline,
      targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
    }),
    collect,
  };
}

describe("dispatchChecks", () => {
  it("reserves the legacy adapter type for formatting", () => {
    expectTypeOf<
      LegacyCheckResultAdapter["id"]
    >().toEqualTypeOf<"formatting">();
  });

  it("fails closed before running a non-formatting legacy adapter", async () => {
    let runs = 0;
    const adapter = {
      id: "lint",
      output: "legacy-check-result",
      inspect: async () => ({
        applies: true as const,
        executionClass: "lightweight" as const,
        requiresBaseline: false,
        targets: [{ id: ".", kind: "repository" as const, relativeRoot: "." }],
      }),
      runLegacy: async () => {
        runs += 1;
        return completed("lint");
      },
    } as unknown as CheckAdapter;

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ lint: "error" })),
    );

    expect(runs).toBe(0);
    expect(results).toEqual([
      {
        result: expect.objectContaining({
          checkId: "lint",
          status: "incomplete",
          findings: [],
          error: {
            code: "ADAPTER_INVALID",
            message: "Lint has an invalid adapter definition.",
            remediation:
              "Check the installed Zedbee version and run zedbee doctor.",
          },
        }),
        policy: null,
      },
    ]);
  });

  it("snapshots a stateful adapter before inspection and never enters lint legacy execution", async () => {
    let outputReads = 0;
    let observationRuns = 0;
    let legacyRuns = 0;
    let unexpectedReads = 0;
    const adapter = {
      id: "lint",
      get output() {
        outputReads += 1;
        return outputReads === 1 ? "observations" : "legacy-check-result";
      },
      inspect: async () => ({
        applies: true as const,
        executionClass: "lightweight" as const,
        requiresBaseline: false,
        targets: [{ id: ".", kind: "repository" as const, relativeRoot: "." }],
      }),
      collect: async (context: CheckRunContext) => {
        observationRuns += 1;
        return {
          checkId: "lint",
          target: context.target,
          baselineObservations: [],
          targetObservations: [],
        };
      },
      runLegacy: async () => {
        legacyRuns += 1;
        return completed("lint");
      },
      get unexpected() {
        unexpectedReads += 1;
        throw new Error("must not be observed");
      },
    } as unknown as CheckAdapter;

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ lint: "error" })),
    );

    expect(outputReads).toBe(1);
    expect(observationRuns).toBe(1);
    expect(legacyRuns).toBe(0);
    expect(unexpectedReads).toBe(0);
    expect(results[0]?.result.status).toBe("completed");
  });

  it("uses the snapshotted observation function when inspect mutates the raw adapter", async () => {
    let observationRuns = 0;
    let legacyRuns = 0;
    const adapter = {
      id: "lint",
      output: "observations",
      inspect: async () => {
        adapter.output = "legacy-check-result";
        adapter.collect = async () => {
          throw new Error("mutated collect must not run");
        };
        return {
          applies: true as const,
          executionClass: "lightweight" as const,
          requiresBaseline: false,
          targets: [
            { id: ".", kind: "repository" as const, relativeRoot: "." },
          ],
        };
      },
      collect: async (context: CheckRunContext) => {
        observationRuns += 1;
        return {
          checkId: "lint",
          target: context.target,
          baselineObservations: [],
          targetObservations: [],
        };
      },
      runLegacy: async () => {
        legacyRuns += 1;
        return completed("lint");
      },
    };

    const results = await dispatchChecks(
      [adapter as unknown as CheckAdapter],
      createContext(createConfig({ lint: "error" })),
    );

    expect(observationRuns).toBe(1);
    expect(legacyRuns).toBe(0);
    expect(results[0]?.result.status).toBe("completed");
  });

  it("fails closed when an allowed adapter getter throws", async () => {
    const adapter = {
      id: "lint",
      get output(): never {
        throw new Error("private-token-123");
      },
      inspect: async () => ({ applies: false as const, reason: "unused" }),
    } as unknown as CheckAdapter;

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ lint: "error" })),
    );

    expect(results).toEqual([
      {
        result: expect.objectContaining({
          checkId: "lint",
          status: "incomplete",
          findings: [],
          error: {
            code: "ADAPTER_INVALID",
            message: "Lint has an invalid adapter definition.",
            remediation:
              "Check the installed Zedbee version and run zedbee doctor.",
          },
        }),
        policy: null,
      },
    ]);
    expect(JSON.stringify(results)).not.toContain("private-token-123");
  });

  it("reports a safe phase-specific diagnostic when inspection fails", async () => {
    const adapter: ObservationCheckAdapter = {
      id: "lint",
      output: "observations",
      inspect: async () => {
        throw new Error("private-token-123");
      },
      collect: async () => {
        throw new Error("must not collect");
      },
    };

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ lint: "error" })),
    );

    expect(results[0]?.result).toMatchObject({
      checkId: "lint",
      status: "incomplete",
      findings: [],
      error: {
        code: "ADAPTER_INSPECTION_FAILED",
        message: "Lint could not determine whether it applies.",
        remediation:
          "Check the repository configuration and run zedbee doctor.",
      },
    });
    expect(JSON.stringify(results)).not.toContain("private-token-123");
  });

  it.each<
    [
      string,
      {
        status?: string;
        severity?: string;
        attributionKind?: string;
        staged?: string;
      },
    ]
  >([
    ["status", { status: "completed.toUpperCase()" }],
    ["severity", { severity: "error.verbose" }],
    ["attribution", { attributionKind: "range-overlap.verbose" }],
    ["staged", { staged: "true" }],
  ])(
    "turns an invalid adapter result %s into incomplete",
    async (_label, mutation) => {
      const adapter = createLegacyAdapter(
        async () =>
          ({
            checkId: "formatting",
            status: mutation.status ?? "completed",
            durationMs: 0,
            findings: [
              {
                id: "unsafe-enum",
                check: "formatting",
                rule: "prettier",
                severity: mutation.severity ?? "error",
                message: "unsafe enum payload",
                attribution: {
                  kind: mutation.attributionKind ?? "syntax-ownership",
                  staged: mutation.staged ?? true,
                  evidence: [],
                },
              },
            ],
          }) as unknown as CheckResult,
      );

      const results = await dispatchChecks(
        [adapter],
        createContext(createConfig({ formatting: "error" })),
      );

      expect(results[0]?.result).toMatchObject({
        checkId: "formatting",
        target: ".",
        status: "incomplete",
        findings: [],
        error: {
          code: "ADAPTER_RESULT_INVALID",
          message:
            "Formatting returned an invalid result for the repository root.",
          remediation: "Run zedbee doctor and update Zedbee before retrying.",
        },
      });
      expect(JSON.stringify(results)).not.toContain("unsafe enum payload");
    },
  );

  it("snapshots applicability before target access can mutate later scheduling fields", async () => {
    const applicability = {
      applies: true as const,
      executionClass: "lightweight" as string,
      requiresBaseline: false,
      targets: [] as CheckTarget[],
    };
    applicability.targets = [
      {
        get id() {
          applicability.executionClass = "corrupted";
          applicability.requiresBaseline = true;
          return ".";
        },
        kind: "repository",
        relativeRoot: ".",
      },
    ];
    const adapter: ObservationCheckAdapter = {
      id: "lint",
      output: "observations",
      inspect: async () =>
        applicability as unknown as Awaited<
          ReturnType<ObservationCheckAdapter["inspect"]>
        >,
      collect: async (context) => ({
        checkId: "lint",
        target: context.target,
        baselineObservations: [],
        targetObservations: [],
      }),
    };

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ lint: "error" })),
    );

    expect(applicability.executionClass).toBe("corrupted");
    expect(applicability.requiresBaseline).toBe(true);
    expect(results[0]?.result.status).toBe("completed");
  });

  it("rejects an observation attributed to a sibling workspace", async () => {
    const target = {
      id: "apps/web",
      kind: "workspace" as const,
      relativeRoot: "apps/web",
    };
    const adapter: ObservationCheckAdapter = {
      id: "lint",
      output: "observations",
      inspect: async () => ({
        applies: true,
        executionClass: "lightweight",
        requiresBaseline: false,
        targets: [target],
      }),
      collect: async (context) => ({
        checkId: "lint",
        target: context.target,
        baselineObservations: [],
        targetObservations: [
          {
            check: "lint",
            rule: "cross-workspace",
            identity: "cross-workspace:packages/core/src/index.ts:1",
            severity: "error",
            message: "Must not be attributed to apps/web",
            location: {
              file: "packages/core/src/index.ts",
              startLine: 1,
              endLine: 1,
            },
          },
        ],
      }),
    };

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ lint: "error" })),
    );

    expect(results[0]?.result).toMatchObject({
      checkId: "lint",
      target: "apps/web",
      status: "incomplete",
      findings: [],
      error: {
        code: "ADAPTER_RESULT_INVALID",
        message: "Lint returned an invalid result for apps/web.",
        remediation: "Run zedbee doctor and update Zedbee before retrying.",
      },
    });
    expect(JSON.stringify(results)).not.toContain("Must not be attributed");
  });

  it.each(["check", "target", "observation"] as const)(
    "fails closed when an observation set returns a mismatched %s",
    async (mismatch) => {
      const adapter = observationAdapter(async (context) => ({
        checkId: mismatch === "check" ? "types" : "formatting",
        target:
          mismatch === "target"
            ? { id: "elsewhere", kind: "repository", relativeRoot: "." }
            : context.target,
        baselineObservations: [],
        targetObservations: [
          mismatch === "observation"
            ? { ...formattingObservation, check: "types" }
            : formattingObservation,
        ],
      }));

      const results = await dispatchChecks(
        [adapter],
        createContext(createConfig({ formatting: "error" })),
      );

      expect(results[0]?.result).toMatchObject({
        checkId: "formatting",
        target: ".",
        status: "incomplete",
        findings: [],
        error: {
          code: "ADAPTER_RESULT_INVALID",
          message:
            "Formatting returned an invalid result for the repository root.",
          remediation: "Run zedbee doctor and update Zedbee before retrying.",
        },
      });
      expect(JSON.stringify(results)).not.toContain("Fixture observation");
    },
  );

  it("classifies malformed cacheable observations as invalid adapter output", async () => {
    const adapter: ObservationCheckAdapter = {
      id: "lint",
      output: "observations",
      inspect: async () => ({
        applies: true,
        executionClass: "lightweight",
        requiresBaseline: false,
        targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
      }),
      collect: async (context) => ({
        checkId: "types",
        target: context.target,
        baselineObservations: [],
        targetObservations: [
          { ...formattingObservation, message: "private-token-123" },
        ],
      }),
    };

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ lint: "error" })),
    );

    expect(results[0]?.result).toMatchObject({
      checkId: "lint",
      target: ".",
      status: "incomplete",
      findings: [],
      error: {
        code: "ADAPTER_RESULT_INVALID",
        message: "Lint returned an invalid result for the repository root.",
        remediation: "Run zedbee doctor and update Zedbee before retrying.",
      },
    });
    expect(JSON.stringify(results)).not.toContain("private-token-123");
  });

  it("enforces the adapter's baseline declaration", async () => {
    const undeclared = observationAdapter(
      async (context) => ({
        checkId: "formatting",
        target: context.target,
        baselineObservations: [formattingObservation],
        targetObservations: [],
      }),
      false,
    );
    const missing = observationAdapter(async (context) => ({
      checkId: "formatting",
      target: context.target,
      baselineObservations: undefined as unknown as readonly Observation[],
      targetObservations: [],
    }));
    const declared = observationAdapter(async (context) => ({
      checkId: "formatting",
      target: context.target,
      baselineObservations: [formattingObservation],
      targetObservations: [],
    }));
    const context = createContext(createConfig({ formatting: "error" }));

    const [undeclaredResult, missingResult, declaredResult] = await Promise.all(
      [
        dispatchChecks([undeclared], context),
        dispatchChecks([missing], context),
        dispatchChecks([declared], context),
      ],
    );

    expect(undeclaredResult[0]?.result.status).toBe("incomplete");
    expect(missingResult[0]?.result.status).toBe("incomplete");
    expect(declaredResult[0]?.result.status).toBe("completed");
  });

  it("copies only public target fields without observing unrelated getters", async () => {
    let unexpectedReads = 0;
    const target = {
      id: "web",
      kind: "workspace",
      relativeRoot: "apps/web",
      adapterSecret: "must not escape",
      get unexpected() {
        unexpectedReads += 1;
        throw new Error("must not be read");
      },
    } as unknown as CheckTarget;
    const events: ScanEvent[] = [];

    const results = await dispatchChecks(
      [createAdapter("formatting", "lightweight", undefined, [target])],
      createContext(createConfig({ formatting: "error" })),
      { onEvent: (event) => events.push(event) },
    );

    expect(unexpectedReads).toBe(0);
    expect(results[0]?.target).toEqual({
      id: "web",
      kind: "workspace",
      relativeRoot: "apps/web",
    });
    expect(Object.keys(results[0]?.target ?? {})).toEqual([
      "id",
      "kind",
      "relativeRoot",
    ]);
    expect(JSON.stringify({ results, events })).not.toMatch(
      /adapterSecret|unexpected|must not escape/,
    );
  });

  it("fails closed when an allowed target field getter throws", async () => {
    let idReads = 0;
    const target = {
      get id(): string {
        idReads += 1;
        throw new Error("sensitive target getter failure");
      },
      kind: "workspace",
      relativeRoot: "apps/web",
    } as CheckTarget;

    const results = await dispatchChecks(
      [createAdapter("formatting", "lightweight", undefined, [target])],
      createContext(createConfig({ formatting: "error" })),
    );

    expect(idReads).toBe(1);
    expect(results).toEqual([
      {
        result: expect.objectContaining({
          checkId: "formatting",
          status: "incomplete",
          findings: [],
          error: {
            code: "ADAPTER_INSPECTION_FAILED",
            message: "Formatting could not determine whether it applies.",
            remediation:
              "Check the repository configuration and run zedbee doctor.",
          },
        }),
        policy: null,
      },
    ]);
    expect(JSON.stringify(results)).not.toContain("sensitive target getter");
  });

  it("detaches completed event results from the policy execution envelope", async () => {
    const adapter = createLegacyAdapter(async () => ({
      checkId: "formatting",
      status: "completed",
      durationMs: 0,
      findings: [
        {
          id: "formatting:value.ts:1",
          check: "formatting",
          rule: "prettier",
          severity: "info",
          message: "Format value.ts",
          location: { file: "value.ts", startLine: 1 },
          attribution: {
            kind: "range-overlap",
            staged: true,
            evidence: ["value.ts:1"],
          },
        },
      ],
    }));

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ formatting: "error" })),
      {
        onEvent: (event) => {
          if (event.type !== "check-completed") return;
          const finding = event.result.findings[0] as unknown as {
            message: string;
            attribution: { evidence: string[] };
          };
          finding.message = "observer mutation";
          finding.attribution.evidence.push("observer evidence");
          Object.freeze(event.result.findings);
          Object.freeze(event.result);
        },
      },
    );

    expect(results[0]?.result.findings).toEqual([
      expect.objectContaining({
        message: "Format value.ts",
        attribution: expect.objectContaining({ evidence: ["value.ts:1"] }),
      }),
    ]);
  });

  it("gives inspect and collect exhaustive immutable copies while preserving authoritative policy and changes", async () => {
    const config = createConfig({ lint: "error" });
    const context = createContext(config);
    const authoritativeFile = {
      path: "src/value.ts",
      status: "modified" as const,
      addedRanges: [{ start: 3, end: 4 }],
    };
    context.changeSet = {
      files: new Map([[authoritativeFile.path, authoritativeFile]]),
      isEmpty: false,
      containsAddedLine: (file, line) =>
        file === authoritativeFile.path && line >= 3 && line <= 4,
    };
    context.targetInspection = {
      ...context.targetInspection,
      workspaces: context.targetInspection.workspaces.map((workspace) =>
        workspace.relativeRoot === "."
          ? { ...workspace, sourceFiles: [authoritativeFile.path] }
          : workspace,
      ),
    };
    const mutationFailures: string[] = [];
    const mutate = (phase: string, adapterContext: CheckRunContext) => {
      for (const [name, action] of [
        ["policy", () => (adapterContext.config.checks.lint.severity = "off")],
        [
          "files",
          () =>
            (
              adapterContext.changeSet.files as unknown as Map<string, unknown>
            ).clear(),
        ],
        [
          "range",
          () =>
            ((
              adapterContext.changeSet.files.get("src/value.ts")!
                .addedRanges[0] as {
                start: number;
              }
            ).start = 99),
        ],
        [
          "workspace",
          () =>
            (
              adapterContext.targetInspection.workspaces as unknown as unknown[]
            ).push({}),
        ],
      ] as const) {
        try {
          action();
        } catch {
          mutationFailures.push(`${phase}:${name}`);
        }
      }
    };
    const adapter: ObservationCheckAdapter = {
      id: "lint",
      output: "observations",
      inspect: async (inspectContext) => {
        mutate("inspect", inspectContext as CheckRunContext);
        return {
          applies: true,
          executionClass: "lightweight",
          requiresBaseline: false,
          targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
        };
      },
      collect: async (runContext) => {
        mutate("collect", runContext);
        expect("cleanup" in runContext.snapshots).toBe(false);
        expect(runContext.changeSet.containsAddedLine("src/value.ts", 3)).toBe(
          true,
        );
        return {
          checkId: "lint",
          target: runContext.target,
          baselineObservations: [],
          targetObservations: [
            {
              check: "lint",
              rule: "repo-rule",
              identity: "repo-rule:new",
              severity: "info",
              message: "New repository issue",
            },
          ],
        };
      },
    };

    const results = await dispatchChecks([adapter], context);
    const decision = evaluatePolicy(results, config);

    expect(mutationFailures).toEqual([
      "inspect:policy",
      "inspect:files",
      "inspect:range",
      "inspect:workspace",
      "collect:policy",
      "collect:files",
      "collect:range",
      "collect:workspace",
    ]);
    expect(context.changeSet.files.get("src/value.ts")).toEqual(
      authoritativeFile,
    );
    expect(decision.outcome).toBe("blocked");
    expect(decision.results[0]?.findings[0]?.severity).toBe("error");
  });

  it("detaches and deeply freezes configuration before adapters receive it", async () => {
    const sourceOption = { allow: ["warn"] };
    const sourceExclusion = {
      files: ["generated/**"],
      checks: ["lint"] as const,
      reason: "Generated files are intentionally excluded.",
    };
    const resolved = resolveConfig({ schemaVersion: 1, profile: "fast" });
    const config = {
      ...resolved,
      pathExclusions: [sourceExclusion],
      checks: {
        ...resolved.checks,
        lint: {
          ...resolved.checks.lint,
          severity: "error" as const,
          rules: {
            ...resolved.checks.lint.rules,
            "no-console": ["warn", sourceOption] as const,
          },
        },
      },
    } satisfies ResolvedConfig;
    let adapterOption: { readonly allow: readonly string[] } | undefined;
    let adapterExclusion: ResolvedConfig["pathExclusions"][number] | undefined;
    const assertSnapshot = (adapterContext: CheckRunContext) => {
      const configuration = adapterContext.config.checks.lint.rules[
        "no-console"
      ] as readonly [string, { readonly allow: readonly string[] }];
      adapterOption = configuration[1];
      expect(configuration).not.toBe(config.checks.lint.rules["no-console"]);
      expect(adapterOption).not.toBe(sourceOption);
      expect(adapterOption.allow).not.toBe(sourceOption.allow);
      expect(Object.isFrozen(configuration)).toBe(true);
      expect(Object.isFrozen(adapterOption)).toBe(true);
      expect(Object.isFrozen(adapterOption.allow)).toBe(true);
      adapterExclusion = adapterContext.config.pathExclusions[0];
      expect(adapterExclusion).not.toBe(sourceExclusion);
      expect(adapterExclusion?.files).not.toBe(sourceExclusion.files);
      expect(adapterExclusion?.checks).not.toBe(sourceExclusion.checks);
      expect(Object.isFrozen(adapterContext.config.pathExclusions)).toBe(true);
      expect(Object.isFrozen(adapterExclusion)).toBe(true);
      expect(Object.isFrozen(adapterExclusion?.files)).toBe(true);
      expect(Object.isFrozen(adapterExclusion?.checks)).toBe(true);
    };
    const adapter: ObservationCheckAdapter = {
      id: "lint",
      output: "observations",
      inspect: async (inspectContext) => {
        assertSnapshot(inspectContext as CheckRunContext);
        return {
          applies: true,
          executionClass: "lightweight",
          requiresBaseline: false,
          targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
        };
      },
      collect: async (runContext) => {
        assertSnapshot(runContext);
        return {
          checkId: "lint",
          target: runContext.target,
          baselineObservations: [],
          targetObservations: [],
        };
      },
    };

    await dispatchChecks([adapter], createContext(config));
    sourceOption.allow.push("error");
    sourceExclusion.files.push("later/**");

    expect(adapterOption?.allow).toEqual(["warn"]);
    expect(adapterExclusion?.files).toEqual(["generated/**"]);
  });

  it("rejects executable rule option values before invoking adapters", async () => {
    const resolved = resolveConfig({ schemaVersion: 1, profile: "fast" });
    const config = {
      ...resolved,
      checks: {
        ...resolved.checks,
        lint: {
          ...resolved.checks.lint,
          severity: "error" as const,
          rules: {
            ...resolved.checks.lint.rules,
            "no-console": [
              "warn",
              { format: () => "executable content" },
            ] as const,
          },
        },
      },
    } satisfies ResolvedConfig;
    let inspections = 0;
    let collections = 0;
    const adapter: ObservationCheckAdapter = {
      id: "lint",
      output: "observations",
      inspect: async () => {
        inspections += 1;
        return {
          applies: true,
          executionClass: "lightweight",
          requiresBaseline: false,
          targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
        };
      },
      collect: async (runContext) => {
        collections += 1;
        return {
          checkId: "lint",
          target: runContext.target,
          baselineObservations: [],
          targetObservations: [],
        };
      },
    };

    await expect(
      dispatchChecks([adapter], createContext(config)),
    ).rejects.toThrow(/JSON-compatible/u);
    expect(inspections).toBe(0);
    expect(collections).toBe(0);
  });

  it("emits policy-filtered and severity-mapped completed results", async () => {
    const events: ScanEvent[] = [];
    const adapter = createLegacyAdapter(async () => ({
      checkId: "formatting",
      status: "completed",
      durationMs: 0,
      findings: [
        {
          id: "baseline-only",
          check: "formatting",
          rule: "prettier",
          severity: "error",
          message: "Unchanged issue",
          attribution: { kind: "none", staged: false, evidence: [] },
        },
        {
          id: "staged",
          check: "formatting",
          rule: "prettier",
          severity: "info",
          message: "Changed issue",
          attribution: {
            kind: "transformation-diff",
            staged: true,
            evidence: ["staged"],
          },
        },
      ],
    }));
    const config = createConfig({ formatting: "warn" });
    const results = await dispatchChecks([adapter], createContext(config), {
      onEvent: (event) => events.push(event),
    });
    const completedEvent = events.find(
      (event): event is Extract<ScanEvent, { type: "check-completed" }> =>
        event.type === "check-completed",
    );

    expect(completedEvent?.result.findings).toEqual([
      expect.objectContaining({ id: "staged", severity: "warning" }),
    ]);
    expect(completedEvent?.result).toEqual(
      evaluatePolicy(results, config).results[0],
    );
  });

  it("uses each finding path for live and final policy in one workspace", async () => {
    const events: ScanEvent[] = [];
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: "error" },
      overrides: [{ files: ["test/**"], checks: { formatting: "warn" } }],
    });
    const context = createContext(config);
    context.targetInspection = {
      ...context.targetInspection,
      workspaces: context.targetInspection.workspaces.map((workspace) =>
        workspace.relativeRoot === "."
          ? {
              ...workspace,
              sourceFiles: ["src/app.ts", "test/app.test.ts"],
            }
          : workspace,
      ),
    };
    const adapter = createLegacyAdapter(async () => ({
      checkId: "formatting",
      status: "completed",
      durationMs: 0,
      findings: [
        {
          id: "source",
          check: "formatting",
          rule: "prettier",
          severity: "info",
          message: "Format source",
          location: { file: "src/app.ts", startLine: 1 },
          attribution: {
            kind: "transformation-diff",
            staged: true,
            evidence: ["src/app.ts"],
          },
        },
        {
          id: "test",
          check: "formatting",
          rule: "prettier",
          severity: "info",
          message: "Format test",
          location: { file: "test/app.test.ts", startLine: 1 },
          attribution: {
            kind: "transformation-diff",
            staged: true,
            evidence: ["test/app.test.ts"],
          },
        },
      ],
    }));

    const executions = await dispatchChecks([adapter], context, {
      onEvent: (event) => events.push(event),
    });
    const finalResult = evaluatePolicy(executions, config).results[0];
    const completedEvent = events.find(
      (event): event is Extract<ScanEvent, { type: "check-completed" }> =>
        event.type === "check-completed",
    );

    expect(
      finalResult?.findings.map(({ id, severity }) => ({ id, severity })),
    ).toEqual([
      { id: "source", severity: "error" },
      { id: "test", severity: "warning" },
    ]);
    expect(completedEvent?.result).toEqual(finalResult);
  });

  it("runs a file-scoped check when one relevant workspace path remains enabled", async () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: "off" },
      overrides: [
        { files: ["apps/web/src/**"], checks: { lint: "error" } },
        { files: ["apps/web/test/**"], checks: { lint: "off" } },
      ],
    });
    const context = createContext(config);
    const stagedPaths = ["apps/web/src/app.ts", "apps/web/test/app.test.ts"];
    context.changeSet = {
      files: new Map(
        stagedPaths.map((path) => [
          path,
          {
            path,
            status: "modified" as const,
            addedRanges: [{ start: 1, end: 1 }],
          },
        ]),
      ),
      isEmpty: false,
      containsAddedLine: () => true,
    };
    context.targetInspection = {
      ...context.targetInspection,
      workspaces: context.targetInspection.workspaces.map((workspace) =>
        workspace.relativeRoot === "apps/web"
          ? {
              ...workspace,
              sourceFiles: stagedPaths,
            }
          : workspace,
      ),
    };
    let runs = 0;

    const adapter: ObservationCheckAdapter = {
      ...lintAdapter,
      collect: async (runContext) => {
        runs += 1;
        return {
          checkId: "lint",
          target: runContext.target,
          baselineObservations: [],
          targetObservations: [],
        };
      },
    };
    const executions = await dispatchChecks([adapter], context);

    expect(runs).toBe(1);
    expect(executions[0]?.policy?.severity).toBe("off");
  });

  it("does not schedule file-scoped lint when only the changed relevant path is off", async () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: "off" },
      overrides: [{ files: ["src/enabled.js"], checks: { lint: "error" } }],
    });
    const context = createContext(config);
    const sourcePaths = ["src/enabled.js", "test/off.js"];
    const staged = {
      path: "test/off.js",
      status: "modified" as const,
      addedRanges: [{ start: 1, end: 1 }],
    };
    context.changeSet = {
      files: new Map([[staged.path, staged]]),
      isEmpty: false,
      containsAddedLine: () => true,
    };
    context.targetInspection = {
      ...context.targetInspection,
      workspaces: context.targetInspection.workspaces.map((workspace) =>
        workspace.relativeRoot === "."
          ? { ...workspace, sourceFiles: sourcePaths }
          : workspace,
      ),
    };
    let runs = 0;
    const adapter = createAdapter("lint", "project-analysis", async () => {
      runs += 1;
      return completed("lint");
    });

    const executions = await dispatchChecks([adapter], context);

    expect(runs).toBe(0);
    expect(executions).toEqual([]);
  });

  it("schedules an enabled matching always override without staged files", async () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: "off" },
      overrides: [
        {
          files: ["src/enabled.js"],
          checks: { lint: { severity: "error", when: "always" } },
        },
      ],
    });
    const context = createContext(config);
    context.changeSet = {
      files: new Map(),
      isEmpty: true,
      containsAddedLine: () => false,
    };
    context.targetInspection = {
      ...context.targetInspection,
      workspaces: context.targetInspection.workspaces.map((workspace) =>
        workspace.relativeRoot === "."
          ? { ...workspace, sourceFiles: ["src/enabled.js"] }
          : workspace,
      ),
    };
    let runs = 0;
    const adapter: ObservationCheckAdapter = {
      ...lintAdapter,
      collect: async (runContext) => {
        runs += 1;
        return {
          checkId: "lint",
          target: runContext.target,
          baselineObservations: [],
          targetObservations: [],
        };
      },
    };

    const executions = await dispatchChecks([adapter], context);

    expect(runs).toBe(1);
    expect(executions).toHaveLength(1);
  });

  it("keeps duplication scheduling workspace-wide for mixed file overrides", async () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { duplication: "off" },
      overrides: [
        { files: ["src/**"], checks: { duplication: "error" } },
        { files: ["test/**"], checks: { duplication: "off" } },
      ],
    });
    const context = createContext(config);
    const stagedPaths = ["src/app.ts", "test/app.test.ts"];
    context.changeSet = {
      files: new Map(
        stagedPaths.map((path) => [
          path,
          {
            path,
            status: "modified" as const,
            addedRanges: [{ start: 1, end: 1 }],
          },
        ]),
      ),
      isEmpty: false,
      containsAddedLine: () => true,
    };
    context.targetInspection = {
      ...context.targetInspection,
      workspaces: context.targetInspection.workspaces.map((workspace) =>
        workspace.relativeRoot === "."
          ? { ...workspace, sourceFiles: stagedPaths }
          : workspace,
      ),
    };
    let runs = 0;
    const adapter: ObservationCheckAdapter = {
      ...duplicationAdapter,
      collect: async (runContext) => {
        runs += 1;
        return {
          checkId: "duplication",
          target: runContext.target,
          baselineObservations: [],
          targetObservations: [],
        };
      },
    };

    const executions = await dispatchChecks([adapter], context);

    expect(runs).toBe(0);
    expect(executions).toEqual([]);
  });

  it("runs formatting when a supported staged Markdown path is enabled by override", async () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: "off" },
      overrides: [{ files: ["docs/**"], checks: { formatting: "error" } }],
    });
    const context = createContext(config);
    const staged = {
      path: "docs/guide.md",
      status: "modified" as const,
      addedRanges: [{ start: 1, end: 1 }],
    };
    context.changeSet = {
      files: new Map([[staged.path, staged]]),
      isEmpty: false,
      containsAddedLine: () => true,
    };
    let runs = 0;
    const adapter: LegacyCheckResultAdapter = {
      ...prettierAdapter,
      runLegacy: async () => {
        runs += 1;
        return completed("formatting");
      },
    };

    const executions = await dispatchChecks([adapter], context);

    expect(runs).toBe(1);
    expect(executions[0]?.policy?.severity).toBe("off");
  });

  it("does not schedule formatting for an enabled unsupported staged path", async () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: "off" },
      overrides: [{ files: ["images/**"], checks: { formatting: "error" } }],
    });
    const context = createContext(config);
    const files = [
      {
        path: "src/app.ts",
        status: "modified" as const,
        addedRanges: [{ start: 1, end: 1 }],
      },
      {
        path: "images/logo.png",
        status: "modified" as const,
        addedRanges: [{ start: 1, end: 1 }],
      },
    ];
    context.changeSet = {
      files: new Map(files.map((file) => [file.path, file])),
      isEmpty: false,
      containsAddedLine: () => true,
    };
    context.targetInspection = {
      ...context.targetInspection,
      workspaces: context.targetInspection.workspaces.map((workspace) =>
        workspace.relativeRoot === "."
          ? { ...workspace, sourceFiles: ["src/app.ts"] }
          : workspace,
      ),
    };
    let runs = 0;
    const adapter: LegacyCheckResultAdapter = {
      ...prettierAdapter,
      runLegacy: async () => {
        runs += 1;
        return completed("formatting");
      },
    };

    const executions = await dispatchChecks([adapter], context);

    expect(runs).toBe(0);
    expect(executions).toEqual([]);
  });

  it("uses metric entity paths for identical live and final file policy", async () => {
    const baseline = await createInspectionFixture();
    const targetFixture = await createInspectionFixture();
    for (const fixture of [baseline, targetFixture]) {
      await fixture.writeJson("package.json", { name: "root" });
      await fixture.write(
        "src/off.ts",
        "export function offMetric() { return 1; }\n",
      );
      await fixture.write(
        "test/warn.ts",
        "export function warnMetric() { return 1; }\n",
      );
    }
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: {
        cyclomaticComplexity: {
          severity: "error",
          max: 10,
          blockWorsening: true,
        },
      },
      overrides: [
        {
          files: ["src/off.ts"],
          checks: { cyclomaticComplexity: "off" },
        },
        {
          files: ["test/warn.ts"],
          checks: { cyclomaticComplexity: "warn" },
        },
      ],
    });
    const context = { ...createContext(config) };
    const changedFiles = ["src/off.ts", "test/warn.ts"];
    context.repositoryRoot = targetFixture.root;
    context.snapshots = {
      baselineDir: baseline.root,
      targetDir: targetFixture.root,
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
    };
    context.changeSet = {
      files: new Map(
        changedFiles.map((path) => [
          path,
          {
            path,
            status: "modified" as const,
            addedRanges: [{ start: 1, end: 1 }],
          },
        ]),
      ),
      isEmpty: false,
      containsAddedLine: () => true,
    };
    context.baselineInspection = await inspectRepository(baseline.root);
    context.targetInspection = await inspectRepository(targetFixture.root);
    const events: ScanEvent[] = [];
    const metricObservation = (file: string, name: string): Observation => ({
      check: "cyclomaticComplexity",
      rule: "cyclomatic-complexity",
      identity: `function:${file}:${name}`,
      severity: "error",
      message: "Complexity exceeds policy.",
      entity: { kind: "function", name, file },
      metric: { name: "cyclomatic-complexity", value: 11 },
    });
    const adapter: ObservationCheckAdapter = {
      id: "cyclomaticComplexity",
      output: "observations",
      inspect: async () => ({
        applies: true,
        executionClass: "lightweight",
        requiresBaseline: true,
        targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
      }),
      collect: async (runContext) => ({
        checkId: "cyclomaticComplexity",
        target: runContext.target,
        baselineObservations: [],
        targetObservations: [
          metricObservation("src/off.ts", "offMetric"),
          metricObservation("test/warn.ts", "warnMetric"),
        ],
      }),
    };

    const executions = await dispatchChecks([adapter], context, {
      onEvent: (event) => events.push(event),
    });
    const finalResult = evaluatePolicy(executions, config).results[0];
    const completedEvent = events.find(
      (event): event is Extract<ScanEvent, { type: "check-completed" }> =>
        event.type === "check-completed",
    );

    expect(finalResult?.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        location: { file: "test/warn.ts" },
      }),
    ]);
    expect(completedEvent?.result).toEqual(finalResult);
  });

  it("emits a live pass for a completed baseline-only result", async () => {
    const events: ScanEvent[] = [];
    const adapter = createLegacyAdapter(async () => ({
      checkId: "formatting",
      status: "completed",
      durationMs: 0,
      findings: [
        {
          id: "baseline-only",
          check: "formatting",
          rule: "prettier",
          severity: "error",
          message: "Unchanged issue",
          attribution: { kind: "none", staged: false, evidence: [] },
        },
      ],
    }));
    await dispatchChecks(
      [adapter],
      createContext(createConfig({ formatting: "error" })),
      { onEvent: (event) => events.push(event) },
    );

    const completed = events.find((event) => event.type === "check-completed");
    expect(completed).toMatchObject({
      result: { status: "completed", findings: [] },
    });
  });

  it("passes adapters a detached frozen run policy and keeps the authoritative envelope", async () => {
    const targetConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: "warn" },
      overrides: [{ files: ["apps/web/**"], checks: { formatting: "error" } }],
    });
    let adapterPolicy: CheckRunContext["policy"] | undefined;
    let adapterSettings: Readonly<{ singleQuote: boolean }> | undefined;
    let mutationRejected = false;
    let nestedMutationRejected = false;
    const adapter = createLegacyAdapter(
      async (context) => {
        adapterPolicy = context.policy;
        adapterSettings = (
          context.policy as CheckRunContext["config"]["checks"]["formatting"]
        ).settings;
        try {
          (context.policy as { severity: "off" | "warn" | "error" }).severity =
            "warn";
        } catch {
          mutationRejected = true;
        }
        try {
          (adapterSettings as { singleQuote: boolean }).singleQuote = true;
        } catch {
          nestedMutationRejected = true;
        }
        return {
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
        };
      },
      [{ id: "web", kind: "workspace", relativeRoot: "apps/web" }],
    );

    const results = await dispatchChecks(
      [adapter],
      createContext(targetConfig),
    );
    const execution = results[0] as CheckExecutionResult;
    const decision = evaluatePolicy(results, targetConfig);

    expect(execution.policy).toMatchObject({ severity: "error" });
    expect(Object.isFrozen(execution.policy)).toBe(true);
    expect(Object.isFrozen(adapterPolicy)).toBe(true);
    expect(execution.policy).not.toBe(adapterPolicy);
    expect(adapterPolicy).toMatchObject({ severity: "error" });
    expect(adapterSettings).not.toBe(targetConfig.checks.formatting.settings);
    expect(Object.isFrozen(adapterSettings)).toBe(true);
    expect(mutationRejected).toBe(true);
    expect(nestedMutationRejected).toBe(true);
    expect(decision).toMatchObject({ outcome: "blocked", exitCode: 1 });
    expect(decision.results[0]?.findings[0]?.severity).toBe("error");
  });

  it("supports detached immutable custom override patches through inspection and collection", async () => {
    const sourceMetadata = { labels: ["repository"] };
    const overrideMetadata = { labels: ["override"] };
    const base = createConfig({ customPolicy: "error" });
    const customConfig = {
      ...base,
      checks: {
        ...base.checks,
        customPolicy: {
          severity: "error" as const,
          when: "relevant" as const,
          metadata: sourceMetadata,
        },
      },
      overrides: [
        {
          files: ["package.json"],
          checks: {
            customPolicy: {
              severity: "warn" as const,
              metadata: overrideMetadata,
            },
          },
        },
      ],
    } as unknown as ResolvedConfig;
    let inspections = 0;
    let collections = 0;
    const assertOverrideSnapshot = (context: CheckRunContext) => {
      const patch = context.config.overrides[0]?.checks[
        "customPolicy" as CheckId
      ] as unknown as {
        readonly metadata: { readonly labels: readonly string[] };
      };
      expect(patch.metadata).not.toBe(overrideMetadata);
      expect(patch.metadata.labels).not.toBe(overrideMetadata.labels);
      expect(Object.isFrozen(patch)).toBe(true);
      expect(Object.isFrozen(patch.metadata)).toBe(true);
      expect(Object.isFrozen(patch.metadata.labels)).toBe(true);
    };
    const adapter: ObservationCheckAdapter = {
      id: "customPolicy",
      output: "observations",
      inspect: async (context) => {
        inspections += 1;
        assertOverrideSnapshot(context as CheckRunContext);
        return {
          applies: true,
          executionClass: "lightweight",
          requiresBaseline: false,
          targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
        };
      },
      collect: async (context) => {
        collections += 1;
        assertOverrideSnapshot(context);
        const policy = context.policy as unknown as {
          readonly severity: string;
          readonly metadata: { readonly labels: readonly string[] };
        };
        expect(policy).toMatchObject({ severity: "warn" });
        expect(policy.metadata).not.toBe(overrideMetadata);
        expect(policy.metadata.labels).not.toBe(overrideMetadata.labels);
        expect(Object.isFrozen(policy)).toBe(true);
        expect(Object.isFrozen(policy.metadata)).toBe(true);
        expect(Object.isFrozen(policy.metadata.labels)).toBe(true);
        return {
          checkId: "customPolicy",
          target: context.target,
          baselineObservations: [],
          targetObservations: [],
        };
      },
    };

    const results = await dispatchChecks(
      [adapter],
      createContext(customConfig),
    );
    sourceMetadata.labels.push("mutated");
    overrideMetadata.labels.push("mutated");

    expect(inspections).toBe(1);
    expect(collections).toBe(1);
    expect(results[0]?.result.status).toBe("completed");
  });

  it("uses the most permissive configured timing for inspection and the exact target timing for execution", async () => {
    const matchingConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: { severity: "error", when: "relevant" } },
      overrides: [
        { files: ["apps/web/**"], checks: { formatting: { when: "always" } } },
      ],
    });
    const observed: string[] = [];
    const adapter: CheckAdapter = {
      id: "formatting",
      output: "legacy-check-result",
      inspect: async (context) => {
        observed.push(`inspect:${context.config.checks.formatting.when}`);
        return context.config.checks.formatting.when === "always"
          ? {
              applies: true,
              executionClass: "lightweight",
              requiresBaseline: false,
              targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
            }
          : { applies: false, reason: "No relevant files" };
      },
      runLegacy: async (context) => {
        observed.push(`run:${context.policy.when}`);
        return completed("formatting");
      },
    };

    const results = await dispatchChecks(
      [adapter],
      createContext(matchingConfig),
    );

    expect(observed).toEqual(["inspect:always", "run:always"]);
    expect(results).toHaveLength(1);
  });

  it("does not let an unmatched timing override change the exact target policy", async () => {
    const unmatchedConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: { severity: "error", when: "relevant" } },
      overrides: [
        { files: ["private/**"], checks: { formatting: { when: "always" } } },
      ],
    });
    const observed: string[] = [];
    const adapter: CheckAdapter = {
      id: "formatting",
      output: "legacy-check-result",
      inspect: async (context) => {
        observed.push(`inspect:${context.config.checks.formatting.when}`);
        return {
          applies: true,
          executionClass: "lightweight",
          requiresBaseline: false,
          targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
        };
      },
      runLegacy: async (context) => {
        observed.push(`run:${context.policy.when}`);
        return completed("formatting");
      },
    };

    await dispatchChecks([adapter], createContext(unmatchedConfig));

    expect(observed).toEqual(["inspect:always", "run:relevant"]);
  });

  it("fails closed on a programmatically injected file-scoped availability override", async () => {
    const base = createConfig({ vulnerabilities: "error" });
    const unsafeConfig = {
      ...base,
      checks: {
        ...base.checks,
        vulnerabilities: {
          ...base.checks.vulnerabilities,
          onUnavailable: "block" as const,
        },
      },
      overrides: [
        {
          files: ["package.json"],
          checks: { vulnerabilities: { onUnavailable: "warn" as const } },
        },
      ],
    };
    let inspected = false;
    const adapter: CheckAdapter = {
      id: "vulnerabilities",
      output: "observations",
      inspect: async () => {
        inspected = true;
        throw new Error("must not inspect");
      },
      collect: async () => {
        throw new Error("must not collect");
      },
    };

    const results = await dispatchChecks(
      [adapter],
      createContext(unsafeConfig as unknown as ResolvedConfig),
    );

    expect(inspected).toBe(false);
    expect(results.map(({ result }) => result)).toEqual([
      expect.objectContaining({
        checkId: "vulnerabilities",
        status: "incomplete",
        error: {
          code: "POLICY_RESOLUTION_FAILED",
          message: "Vulnerabilities could not resolve its repository policy.",
          remediation:
            "Check the repository configuration and run zedbee doctor.",
        },
      }),
    ]);
  });

  it("returns an incomplete result when an applicable adapter produces no targets", async () => {
    const adapter = createAdapter("lint", "lightweight", undefined, []);

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ lint: "error" })),
    );

    expect(results.map(({ result }) => result)).toEqual([
      expect.objectContaining({
        checkId: "lint",
        status: "incomplete",
        error: {
          code: "ADAPTER_TARGETS_MISSING",
          message:
            "Lint could not determine which selected targets to analyze.",
          remediation:
            "Check the selected paths and repository configuration, then retry.",
        },
      }),
    ]);
  });

  it("emits a complete sanitized lifecycle when target policy resolution fails", async () => {
    const events: ScanEvent[] = [];
    const adapter = createAdapter("types", "project-analysis", undefined, [
      {
        id: "unknown-target",
        kind: "workspace",
        relativeRoot: "missing/workspace",
      },
    ]);

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ types: "error" })),
      { onEvent: (event) => events.push(event) },
    );

    expect(events.map(({ type }) => type)).toEqual([
      "check-queued",
      "check-running",
      "check-completed",
    ]);
    expect(events.every(({ target }) => target === "unknown-target")).toBe(
      true,
    );
    expect(results.map(({ result }) => result)).toEqual([
      expect.objectContaining({
        checkId: "types",
        target: "unknown-target",
        status: "incomplete",
        error: {
          code: "TARGET_POLICY_FAILED",
          message: "TypeScript could not resolve policy for unknown-target.",
          remediation: "Check the target configuration and run zedbee doctor.",
        },
      }),
    ]);
  });

  it("does not inspect disabled adapters", async () => {
    let inspections = 0;
    const adapter: CheckAdapter = {
      id: "disabled",
      output: "observations",
      inspect: async () => {
        inspections += 1;
        return {
          applies: true,
          executionClass: "lightweight",
          requiresBaseline: false,
          targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
        };
      },
      collect: async (context) => ({
        checkId: "disabled",
        target: context.target,
        baselineObservations: [],
        targetObservations: [],
      }),
    };

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ disabled: "off" })),
    );

    expect(inspections).toBe(0);
    expect(results).toEqual([]);
  });

  it("returns a skipped result when an enabled adapter is irrelevant", async () => {
    const adapter: CheckAdapter = {
      id: "irrelevant",
      output: "observations",
      inspect: async () => ({
        applies: false,
        reason: "No supported staged files",
      }),
      collect: async (context) => ({
        checkId: "irrelevant",
        target: context.target,
        baselineObservations: [],
        targetObservations: [],
      }),
    };

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ irrelevant: "error" })),
    );

    expect(results.map(({ result }) => result)).toEqual([
      {
        checkId: "irrelevant",
        status: "skipped",
        durationMs: 0,
        findings: [],
        skipReason: "No supported staged files",
      },
    ]);
  });

  it("emits queued, running, and completed lifecycle events", async () => {
    const events: ScanEvent[] = [];
    let now = 10;
    const adapter = createAdapter("formatting", "lightweight");

    await dispatchChecks(
      [adapter],
      createContext(createConfig({ formatting: "error" })),
      {
        clock: () => now++,
        onEvent: (event) => events.push(event),
      },
    );

    expect(events.map((event) => event.type)).toEqual([
      "check-queued",
      "check-running",
      "check-completed",
    ]);
    expect(events.map((event) => event.checkId)).toEqual([
      "formatting",
      "formatting",
      "formatting",
    ]);
    expect(events.map((event) => event.timestamp)).toEqual([10, 11, 13]);
    expect(events.map((event) => event.target)).toEqual([".", ".", "."]);
    expect(events.at(-1)).toMatchObject({
      type: "check-completed",
      target: ".",
      result: { target: "." },
    });
  });

  it("expands one adapter into deterministic explicit workspace targets", async () => {
    const events: ScanEvent[] = [];
    const adapter = createAdapter(
      "types",
      "project-analysis",
      async (context) => completed(`types:${context.target.id}`),
      [
        {
          id: "packages/core",
          kind: "workspace",
          relativeRoot: "packages/core",
        },
        { id: "apps/web", kind: "workspace", relativeRoot: "apps/web" },
      ],
    );

    const results = await dispatchChecks(
      [adapter],
      createContext(createConfig({ types: "error" })),
      { onEvent: (event) => events.push(event) },
    );

    expect(results.map(({ result }) => result.target)).toEqual([
      "apps/web",
      "packages/core",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "check-running",
        checkId: "types",
        target: "packages/core",
      }),
    );
  });

  it("enforces execution-class concurrency globally across expanded targets", async () => {
    let active = 0;
    let maximum = 0;
    const release = deferred();
    const targets = Array.from({ length: 5 }, (_, index) => ({
      id: `packages/${index}`,
      kind: "workspace" as const,
      relativeRoot: `packages/${index}`,
    }));
    const adapter = createAdapter(
      "lint",
      "lightweight",
      async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        if (active === 2) release.resolve();
        await release.promise;
        active -= 1;
        return completed("lint");
      },
      targets,
    );

    await dispatchChecks(
      [adapter],
      createContext(createConfig({ lint: "error" })),
    );

    expect(maximum).toBe(2);
  });

  it("avoids uncached default identity reads and reuses identities only within each dispatch", async () => {
    const identity = vi
      .spyOn(engineIdentity, "observationCacheEngineIdentity")
      .mockReturnValue(undefined);
    const targets = [".", "apps/web"].map((relativeRoot) => ({
      id: relativeRoot,
      kind: "workspace" as const,
      relativeRoot,
    }));
    const adapter = createAdapter(
      "structuralSecurity",
      "lightweight",
      undefined,
      targets,
    );
    const context = createContext(
      createConfig({ structuralSecurity: "error" }),
    );
    const cache = {
      async get() {
        return undefined;
      },
      async set() {},
    };
    try {
      await dispatchChecks([adapter], context);
      expect(identity).not.toHaveBeenCalled();
      await dispatchChecks([adapter], context, { cache });
      expect(identity).toHaveBeenCalledTimes(1);
      await dispatchChecks([adapter], context, { cache });
      expect(identity).toHaveBeenCalledTimes(2);
      const custom = vi.fn(() => undefined);
      await dispatchChecks([adapter], context, { cacheEngineIdentity: custom });
      expect(custom).toHaveBeenCalledTimes(2);
    } finally {
      identity.mockRestore();
    }
  });

  it("retains safe analyzer failure diagnostics in incomplete results", async () => {
    const diagnostic = analyzerDiagnostic(
      "lint",
      "collect",
      "abnormal-exit",
      7,
    );
    const adapter = createAdapter("lint", "project-analysis", async () => {
      throw new AnalyzerJobError(diagnostic);
    });
    const result = await dispatchChecks(
      [adapter],
      createContext(createConfig({ lint: "error" })),
    );
    expect(result[0]?.result).toMatchObject({
      status: "incomplete",
      error: { diagnostic },
    });
  });

  it("never invokes queued adapters after cancellation", async () => {
    const controller = new AbortController();
    const context = {
      ...createContext(createConfig({ lint: "error" })),
      signal: controller.signal,
    };
    controller.abort();
    let called = false;
    const adapter = createAdapter("lint", "project-analysis", async () => {
      called = true;
      return completed("lint");
    });
    await dispatchChecks([adapter], context);
    expect(called).toBe(false);
  });

  it("limits lightweight checks to two concurrent runs", async () => {
    let active = 0;
    let maximum = 0;
    const release = deferred();
    const adapters = Array.from({ length: 5 }, (_, index) =>
      createAdapter(`light-${index}`, "lightweight", async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        if (active === 2) {
          release.resolve();
        }
        await release.promise;
        active -= 1;
        return completed(`light-${index}`);
      }),
    );

    await dispatchChecks(
      adapters,
      createContext(
        createConfig(
          Object.fromEntries(adapters.map((adapter) => [adapter.id, "error"])),
        ),
      ),
    );

    expect(maximum).toBe(2);
  });

  it.each(["project-analysis", "network"] as const)(
    "limits %s checks to one concurrent run across expanded targets",
    async (executionClass) => {
      let active = 0;
      let maximum = 0;
      const adapters = [0, 1].map((index) =>
        createAdapter(
          `${executionClass}-${index}`,
          executionClass,
          async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await Promise.resolve();
            active -= 1;
            return completed(`${executionClass}-${index}`);
          },
          [
            { id: "packages/0", kind: "workspace", relativeRoot: "packages/0" },
            { id: "packages/1", kind: "workspace", relativeRoot: "packages/1" },
          ],
        ),
      );

      await dispatchChecks(
        adapters,
        createContext(
          createConfig(
            Object.fromEntries(
              adapters.map((adapter) => [adapter.id, "error"]),
            ),
          ),
        ),
      );

      expect(maximum).toBe(1);
    },
  );

  it("sanitizes adapter failures and lets other checks finish", async () => {
    const broken = createAdapter("broken", "lightweight", async () => {
      throw new Error("private-token-123");
    });
    const healthy = createAdapter("healthy", "lightweight");

    const results = await dispatchChecks(
      [broken, healthy],
      createContext(createConfig({ broken: "error", healthy: "error" })),
    );

    expect(results[0]?.result).toMatchObject({
      checkId: "broken",
      target: ".",
      status: "incomplete",
      findings: [],
      error: {
        code: "ADAPTER_EXECUTION_FAILED",
        message: "broken could not analyze the repository root.",
        remediation:
          "Check the analyzer installation and selected input, then retry.",
      },
    });
    expect(results[1]?.result).toMatchObject({
      checkId: "healthy",
      status: "completed",
    });
    expect(JSON.stringify(results)).not.toContain("private-token-123");
  });

  it("preserves safe details and disposition from a known incomplete error", async () => {
    const unavailable = createAdapter(
      "vulnerabilities",
      "network",
      async () => {
        throw new CheckIncompleteError({
          code: "OSV_UNAVAILABLE",
          message: "OSV did not respond before the request deadline.",
          remediation: "Retry the scan or set onUnavailable to warn.",
          path: "package-lock.json",
          disposition: "warn",
        });
      },
    );

    const [execution] = await dispatchChecks(
      [unavailable],
      createContext(createConfig({ vulnerabilities: "error" })),
    );

    expect(execution?.result).toMatchObject({
      checkId: "vulnerabilities",
      status: "incomplete",
      incompleteDisposition: "warn",
      error: {
        code: "OSV_UNAVAILABLE",
        message: "OSV did not respond before the request deadline.",
        remediation: "Retry the scan or set onUnavailable to warn.",
        path: "package-lock.json",
      },
    });
  });

  it("returns results in deterministic check ID order instead of adapter or completion order", async () => {
    const firstRelease = deferred();
    const secondFinished = deferred();
    const first = createAdapter("zeta", "lightweight", async () => {
      await firstRelease.promise;
      return completed("zeta");
    });
    const second = createAdapter("alpha", "lightweight", async () => {
      secondFinished.resolve();
      return completed("alpha");
    });

    const resultPromise = dispatchChecks(
      [first, second],
      createContext(createConfig({ zeta: "error", alpha: "error" })),
    );
    await secondFinished.promise;
    firstRelease.resolve();

    expect((await resultPromise).map(({ result }) => result.checkId)).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("collects immutable fix plans only when explicitly requested", async () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: "warn" },
      overrides: [{ files: ["test/**"], checks: { formatting: "off" } }],
    });
    let providerCalls = 0;
    let receivedFindings: readonly Finding[] | undefined;
    const provider = async (
      _context: CheckRunContext,
      findings: readonly Finding[],
    ): Promise<readonly CheckFixCandidate[]> => {
      providerCalls += 1;
      receivedFindings = findings;
      return [
        {
          kind: "format-file",
          checkId: "formatting",
          file: "src/value.ts",
          findingIds: findings.map((finding) => finding.id),
          severities: findings.map(() => "warning" as const),
          settings: config.checks.formatting.settings,
        },
      ];
    };
    const adapter = Object.assign(
      createLegacyAdapter(async () => ({
        checkId: "formatting",
        status: "completed",
        durationMs: 0,
        findings: [
          {
            id: "baseline-only",
            check: "formatting",
            rule: "prettier",
            severity: "error",
            message: "Unchanged issue",
            location: { file: "src/value.ts", startLine: 1 },
            attribution: { kind: "none", staged: false, evidence: [] },
          },
          {
            id: "enabled-staged",
            check: "formatting",
            rule: "prettier",
            severity: "info",
            message: "Changed issue",
            location: { file: "src/value.ts", startLine: 1 },
            attribution: {
              kind: "transformation-diff",
              staged: true,
              evidence: ["src/value.ts"],
            },
          },
          {
            id: "disabled-staged",
            check: "formatting",
            rule: "prettier",
            severity: "error",
            message: "Disabled file issue",
            location: { file: "test/value.test.ts", startLine: 1 },
            attribution: {
              kind: "transformation-diff",
              staged: true,
              evidence: ["test/value.test.ts"],
            },
          },
        ],
      })),
      { planFixes: provider },
    );

    const ordinary = await dispatchChecks([adapter], createContext(config));

    expect(providerCalls).toBe(0);
    expect(ordinary[0]?.fixCandidates).toBeUndefined();

    const collected = await dispatchChecks([adapter], createContext(config), {
      collectFixes: true,
    });

    expect(providerCalls).toBe(1);
    expect(receivedFindings).toEqual([
      expect.objectContaining({ id: "enabled-staged", severity: "warning" }),
    ]);
    expect(collected[0]?.fixCandidates).toEqual([
      expect.objectContaining({
        kind: "format-file",
        file: "src/value.ts",
        findingIds: ["enabled-staged"],
        severities: ["warning"],
      }),
    ]);
    expect(Object.isFrozen(collected[0]?.fixCandidates)).toBe(true);
  });

  it("contains fix provider failures without disclosing source text", async () => {
    const provider = async () => {
      throw new Error("const privateToken = 'not for reports'");
    };
    const adapter = Object.assign(
      createLegacyAdapter(async () => ({
        checkId: "formatting",
        status: "completed",
        durationMs: 0,
        findings: [
          {
            id: "staged",
            check: "formatting",
            rule: "prettier",
            severity: "error",
            message: "Changed issue",
            attribution: {
              kind: "transformation-diff",
              staged: true,
              evidence: ["src/value.ts"],
            },
          },
        ],
      })),
      { planFixes: provider },
    );

    const [execution] = await dispatchChecks(
      [adapter],
      createContext(createConfig({ formatting: "error" })),
      { collectFixes: true },
    );

    expect(execution?.result).toMatchObject({
      checkId: "formatting",
      status: "incomplete",
      findings: [],
      error: {
        code: "FIX_PROVIDER_FAILED",
        message: "Formatting could not prepare managed fixes.",
        remediation:
          "Update Zedbee or inspect the managed rule compatibility before retrying.",
      },
    });
    expect(execution?.fixCandidates).toBeUndefined();
    expect(JSON.stringify(execution)).not.toContain("privateToken");
  });

  it("fails closed when a provider returns a candidate for another check", async () => {
    const provider = async (): Promise<readonly CheckFixCandidate[]> => [
      {
        kind: "exact-file",
        checkId: "lint",
        file: "src/value.ts",
        baseSource: "const value = 1\n",
        edits: [
          {
            findingId: "staged",
            severity: "error",
            start: 6,
            end: 11,
            replacement: "answer",
          },
        ],
      },
    ];
    const adapter = Object.assign(
      createLegacyAdapter(async () => ({
        checkId: "formatting",
        status: "completed",
        durationMs: 0,
        findings: [
          {
            id: "staged",
            check: "formatting",
            rule: "prettier",
            severity: "error",
            message: "Changed issue",
            attribution: {
              kind: "transformation-diff",
              staged: true,
              evidence: ["src/value.ts"],
            },
          },
        ],
      })),
      { planFixes: provider },
    );

    const [execution] = await dispatchChecks(
      [adapter],
      createContext(createConfig({ formatting: "error" })),
      { collectFixes: true },
    );

    expect(execution?.result.error?.code).toBe("FIX_PROVIDER_FAILED");
    expect(execution?.fixCandidates).toBeUndefined();
  });
});
