import { describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import {
  executeFixCommand,
  parseFixCheck,
  type FixCommandDependencies,
  type FixCommandIO,
} from "../../src/commands/fix.js";
import {
  FIXABLE_CHECK_IDS,
  type PreparedFixPlan,
} from "../../src/fixes/types.js";

function plan(
  overrides: Partial<PreparedFixPlan["publicPlan"]> = {},
): PreparedFixPlan {
  return {
    repositoryRoot: "/repo",
    candidates: [],
    workingFiles: new Map(),
    temporaryReportMaxAgeMs: 86_400_000,
    publicPlan: {
      schemaVersion: 1,
      target: "index",
      selectedChecks: FIXABLE_CHECK_IDS,
      exitCode: 0,
      summary: { fixes: 0, files: 0, blocking: 0, warnings: 0, skipped: 0 },
      files: [],
      items: [],
      ...overrides,
    },
  };
}

function io(
  tty = false,
): FixCommandIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    width: 80,
    env: {},
    stdout,
    stderr,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
}

function dependencies(prepared = plan()): FixCommandDependencies {
  return {
    resolveRepositoryRoot: async () => "/repo",
    buildFixPlan: vi.fn(async () => prepared),
    applyFixPlan: vi.fn(async () => ({
      exitCode: 0 as const,
      appliedFixes: 0,
      changedFiles: [],
      unchangedFiles: [],
      issues: [],
    })),
    confirm: vi.fn(async () => true),
    store: { maintain: vi.fn(async () => ({ warnings: [] })) },
  };
}

function hostilePlan(): PreparedFixPlan {
  const prepared = plan({
    summary: { fixes: 1, files: 1, blocking: 1, warnings: 0, skipped: 0 },
    files: [
      {
        path: "src/value.ts",
        fixes: 1,
        hasUnstagedChanges: false,
      },
    ],
    items: [
      {
        checkId: "lint",
        file: "src/value.ts",
        findingIds: ["lint-1"],
        scope: "finding",
        blocking: 1,
        warnings: 0,
      },
    ],
  });
  Object.assign(prepared.publicPlan, { repositoryRoot: "/private/repo" });
  Object.assign(prepared.publicPlan.summary, { baseSource: "private source" });
  Object.assign(prepared.publicPlan.files[0]!, { replacement: "private edit" });
  Object.assign(prepared.publicPlan.items[0]!, { repositoryRoot: "/private" });
  return prepared;
}

function partialPlan(withFix = true): PreparedFixPlan {
  return plan({
    exitCode: 1,
    checks: [
      {
        checkId: "formatting",
        status: "completed",
        fixes: withFix ? 1 : 0,
        issues: [],
      },
      {
        checkId: "lint",
        status: "incomplete",
        fixes: 0,
        issues: [
          {
            code: "TYPED_LINT_ANALYSIS_FAILED",
            message: "Typed lint analysis could not inspect this file.",
            path: "src/value.ts",
            remediation:
              "Correct the TypeScript project setup and run Zedbee again.",
          },
        ],
      },
      {
        checkId: "reactCorrectness",
        status: "not-applicable",
        fixes: 0,
        issues: [],
        reason: "No React renderer detected",
      },
    ],
    summary: {
      fixes: withFix ? 1 : 0,
      files: withFix ? 1 : 0,
      blocking: withFix ? 1 : 0,
      warnings: 0,
      skipped: 0,
    },
    files: withFix
      ? [{ path: "src/value.ts", fixes: 1, hasUnstagedChanges: false }]
      : [],
    items: withFix
      ? [
          {
            checkId: "formatting",
            file: "src/value.ts",
            findingIds: ["format-1"],
            scope: "working-file",
            fixes: 1,
            blocking: 1,
            warnings: 0,
          },
        ]
      : [],
  });
}

function expectPublicPlan(
  output: unknown,
  applied: boolean,
  result?: unknown,
): void {
  expect(output).toEqual({
    applied,
    schemaVersion: 1,
    target: "index",
    selectedChecks: [...FIXABLE_CHECK_IDS],
    exitCode: 0,
    summary: { fixes: 1, files: 1, blocking: 1, warnings: 0, skipped: 0 },
    files: [{ path: "src/value.ts", fixes: 1, hasUnstagedChanges: false }],
    items: [
      {
        checkId: "lint",
        file: "src/value.ts",
        findingIds: ["lint-1"],
        scope: "finding",
        blocking: 1,
        warnings: 0,
      },
    ],
    ...(result === undefined ? {} : { result }),
  });
}

const base = {
  cwd: "/repo",
  yes: false,
  format: "text" as const,
  color: true,
  animations: true,
};

describe("parseFixCheck", () => {
  it.each(FIXABLE_CHECK_IDS)("accepts the supported %s selector", (value) => {
    expect(parseFixCheck(value)).toBe(value);
  });

  it.each(["types", "format", "lint ", "unknown"])(
    "rejects unsupported selector %s",
    (value) => {
      expect(() => parseFixCheck(value)).toThrow(
        /supported managed fix check/u,
      );
    },
  );
});

describe("executeFixCommand", () => {
  it("selects every supported check for a bare --yes command without prompting", async () => {
    const terminal = io(false);
    const deps = dependencies();

    await expect(
      executeFixCommand({ ...base, yes: true }, terminal, deps),
    ).resolves.toBe(0);
    expect(deps.buildFixPlan).toHaveBeenCalledWith(
      expect.objectContaining({ selectedChecks: FIXABLE_CHECK_IDS }),
    );
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.applyFixPlan).toHaveBeenCalledOnce();
  });

  it("limits a named selector to its single supported check", async () => {
    const terminal = io(false);
    const deps = dependencies();

    await executeFixCommand(
      { ...base, check: "reactCorrectness", yes: true },
      terminal,
      deps,
    );

    expect(deps.buildFixPlan).toHaveBeenCalledWith(
      expect.objectContaining({ selectedChecks: ["reactCorrectness"] }),
    );
  });

  it("prints a non-interactive preview and never writes without --yes", async () => {
    const terminal = io(false);
    const deps = dependencies();

    await expect(executeFixCommand(base, terminal, deps)).resolves.toBe(0);
    expect(deps.applyFixPlan).not.toHaveBeenCalled();
    expect(terminal.stdout.join("")).toContain(
      "Run zedbee fix --yes to apply this plan.",
    );
  });

  it("uses an ordinary interactive terminal confirmation and honors NO_COLOR", async () => {
    const terminal = io(true);
    terminal.env.NO_COLOR = "1";
    const deps = dependencies();

    await executeFixCommand(base, terminal, deps);

    expect(deps.confirm).toHaveBeenCalledWith(expect.any(Object), {
      width: 80,
      color: false,
      animations: false,
    });
    expect(deps.applyFixPlan).toHaveBeenCalledOnce();
  });

  it("previews and applies trustworthy fixes when another selected check is incomplete", async () => {
    const terminal = io(true);
    const deps = dependencies(partialPlan());
    deps.applyFixPlan = vi.fn(async () => ({
      exitCode: 0 as const,
      appliedFixes: 1,
      changedFiles: ["src/value.ts"],
      unchangedFiles: [],
      issues: [],
    }));

    await expect(executeFixCommand(base, terminal, deps)).resolves.toBe(1);

    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.applyFixPlan).toHaveBeenCalledOnce();
    const output = terminal.stdout.join("");
    expect(output).toContain("Zedbee managed fixes partially applied.");
    expect(output).toContain("formatting: READY — 1 fix available");
    expect(output).toContain("lint: INCOMPLETE");
    expect(output).toContain("TYPED LINT ANALYSIS FAILED");
    expect(output).toContain("src/value.ts");
    expect(output).toContain("Correct the TypeScript project setup");
    expect(output).toContain(
      "reactCorrectness: NOT APPLICABLE — No React renderer detected",
    );
  });

  it("applies trustworthy partial fixes with --yes but preserves the incomplete exit", async () => {
    const terminal = io(false);
    const deps = dependencies(partialPlan());

    await expect(
      executeFixCommand({ ...base, yes: true }, terminal, deps),
    ).resolves.toBe(1);

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.applyFixPlan).toHaveBeenCalledOnce();
  });

  it("keeps every provider state in a source-free partial JSON preview", async () => {
    const terminal = io(false);
    const deps = dependencies(partialPlan());

    await expect(
      executeFixCommand({ ...base, format: "json" }, terminal, deps),
    ).resolves.toBe(0);

    expect(deps.applyFixPlan).not.toHaveBeenCalled();
    expect(JSON.parse(terminal.stdout.join(""))).toMatchObject({
      applied: false,
      exitCode: 1,
      checks: [
        { checkId: "formatting", status: "completed", fixes: 1 },
        {
          checkId: "lint",
          status: "incomplete",
          issues: [
            {
              code: "TYPED_LINT_ANALYSIS_FAILED",
              path: "src/value.ts",
            },
          ],
        },
        {
          checkId: "reactCorrectness",
          status: "not-applicable",
          reason: "No React renderer detected",
        },
      ],
    });
    expect(terminal.stdout.join("")).not.toContain("replacement");
    expect(terminal.stdout.join("")).not.toContain("baseSource");
  });

  it("opens a read-only prompt when incomplete checks leave no trustworthy fixes", async () => {
    const terminal = io(true);
    const deps = dependencies(partialPlan(false));
    deps.confirm = vi.fn(async () => false);

    await expect(executeFixCommand(base, terminal, deps)).resolves.toBe(1);

    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.applyFixPlan).not.toHaveBeenCalled();
    expect(terminal.stdout.join("")).toContain("Zedbee fix closed.");
    expect(terminal.stdout.join("")).not.toContain("Zedbee fix cancelled.");
  });

  it("passes the persisted complete-plan path into the interactive confirmation", async () => {
    const terminal = io(true);
    const deps = dependencies();
    deps.store = {
      maintain: vi.fn(async () => ({
        reportPath: "/tmp/zedbee/fix-plan.json",
        warnings: [],
      })),
    };

    await executeFixCommand(base, terminal, deps);

    expect(deps.confirm).toHaveBeenCalledWith(expect.any(Object), {
      width: 80,
      color: true,
      animations: true,
      reportPath: "/tmp/zedbee/fix-plan.json",
    });
  });

  it("persists a complete source-free plan before the UI truncates its thirteenth file", async () => {
    const terminal = io(true);
    const deps = dependencies(
      plan({
        summary: { fixes: 13, files: 13, blocking: 0, warnings: 0, skipped: 0 },
        files: Array.from({ length: 13 }, (_, index) => ({
          path: `src/${index}.ts`,
          fixes: 1,
          hasUnstagedChanges: false,
        })),
        items: Array.from({ length: 13 }, (_, index) => ({
          checkId: "lint" as const,
          file: `src/${index}.ts`,
          findingIds: [`lint-${index}`],
          scope: "finding" as const,
          blocking: 0,
          warnings: 0,
        })),
      }),
    );
    deps.store = {
      maintain: vi.fn(async () => ({
        reportPath: "/tmp/zedbee/fix-plan.json",
        warnings: [],
      })),
    };

    await executeFixCommand(base, terminal, deps);

    expect(deps.store.maintain).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.not.stringContaining("baseSource"),
      }),
    );
    expect(deps.confirm).toHaveBeenCalledWith(expect.any(Object), {
      width: 80,
      color: true,
      animations: true,
      reportPath: "/tmp/zedbee/fix-plan.json",
    });
  });

  it("does not advertise a report path after persistence fails for a thirteen-file prompt", async () => {
    const terminal = io(true);
    const deps = dependencies(
      plan({
        summary: { fixes: 13, files: 13, blocking: 0, warnings: 0, skipped: 0 },
        files: Array.from({ length: 13 }, (_, index) => ({
          path: `src/${index}.ts`,
          fixes: 1,
          hasUnstagedChanges: false,
        })),
        items: Array.from({ length: 13 }, (_, index) => ({
          checkId: "lint" as const,
          file: `src/${index}.ts`,
          findingIds: [`lint-${index}`],
          scope: "finding" as const,
          blocking: 0,
          warnings: 0,
        })),
      }),
    );
    deps.store = {
      maintain: vi.fn(async () => Promise.reject(new Error("disk full"))),
    };
    deps.confirm = vi.fn(async () => false);

    await expect(executeFixCommand(base, terminal, deps)).resolves.toBe(0);

    expect(deps.confirm).toHaveBeenCalledWith(expect.any(Object), {
      width: 80,
      color: true,
      animations: true,
    });
    expect(terminal.stdout.join("")).not.toContain("baseSource");
    expect(terminal.stdout.join("")).not.toContain("Complete plan:");
    expect(terminal.stderr.join("")).toContain("TEMP REPORT WRITE FAILED");
  });

  it("passes its abort signal into an active interactive confirmation", async () => {
    const terminal = io(true);
    const controller = new AbortController();
    const deps = dependencies();
    deps.confirm = vi.fn(async (_plan, promptOptions) => {
      expect(promptOptions.signal).toBe(controller.signal);
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      promptOptions.signal?.throwIfAborted();
      return false;
    });

    await expect(
      executeFixCommand({ ...base, signal: controller.signal }, terminal, deps),
    ).resolves.toBe(2);
    expect(terminal.stderr.join("")).toBe("Zedbee fix was interrupted.\n");
    expect(deps.applyFixPlan).not.toHaveBeenCalled();
  });

  it("reports a cancelled interactive plan without writing", async () => {
    const terminal = io(true);
    const deps = dependencies();
    deps.confirm = vi.fn(async () => false);

    await expect(executeFixCommand(base, terminal, deps)).resolves.toBe(0);
    expect(deps.applyFixPlan).not.toHaveBeenCalled();
    expect(terminal.stdout.join("")).toContain("Zedbee fix cancelled.");
  });

  it("prints permanent cancellation output only after the interactive prompt exits", async () => {
    const terminal = io(true);
    const deps = dependencies();
    deps.confirm = vi.fn(async () => {
      expect(terminal.stdout.join("")).toBe("");
      return false;
    });

    await executeFixCommand(base, terminal, deps);

    expect(terminal.stdout.join("")).toContain("Zedbee managed fix plan.");
    expect(terminal.stdout.join("")).toContain("Zedbee fix cancelled.");
    expect(deps.applyFixPlan).not.toHaveBeenCalled();
  });

  it("shows plan-time skipped exact edits to the confirmer before approval", async () => {
    const terminal = io(true);
    const prepared = plan({
      summary: { fixes: 2, files: 2, blocking: 1, warnings: 1, skipped: 1 },
      files: [
        {
          path: "src/overlap.ts",
          fixes: 1,
          applicableFixes: 0,
          skippedFixes: 1,
          hasUnstagedChanges: true,
        },
        {
          path: "src/safe.ts",
          fixes: 1,
          applicableFixes: 1,
          skippedFixes: 0,
          hasUnstagedChanges: false,
        },
      ],
      items: [
        {
          checkId: "lint",
          file: "src/overlap.ts",
          findingIds: ["overlap"],
          scope: "finding",
          blocking: 1,
          warnings: 0,
          status: "skipped",
          reason: "Working changes overlap a managed exact fix.",
        },
        {
          checkId: "lint",
          file: "src/safe.ts",
          findingIds: ["safe"],
          scope: "finding",
          blocking: 0,
          warnings: 1,
          status: "applicable",
        },
      ],
    });
    const deps = dependencies(prepared);
    deps.confirm = vi.fn(async (publicPlan) => {
      expect(publicPlan.summary.skipped).toBe(1);
      expect(publicPlan.items[0]).toMatchObject({
        status: "skipped",
        reason: "Working changes overlap a managed exact fix.",
      });
      expect(publicPlan.items[1]).toMatchObject({ status: "applicable" });
      return false;
    });

    await expect(executeFixCommand(base, terminal, deps)).resolves.toBe(0);

    expect(terminal.stdout.join("")).toContain(
      'SKIP: "src/overlap.ts" — Working changes overlap a managed exact fix.',
    );
    expect(deps.applyFixPlan).not.toHaveBeenCalled();
  });

  it("reconciles multi-edit and formatting action counts in text and complete JSON", async () => {
    const prepared = plan({
      summary: { fixes: 3, files: 1, blocking: 1, warnings: 2, skipped: 0 },
      files: [
        {
          path: "src/value.ts",
          fixes: 3,
          applicableFixes: 3,
          skippedFixes: 0,
          status: "applicable",
          reasons: [],
          hasUnstagedChanges: false,
        },
      ],
      items: [
        {
          checkId: "lint",
          file: "src/value.ts",
          findingIds: ["lint-error", "lint-warning"],
          scope: "finding",
          fixes: 2,
          blocking: 1,
          warnings: 1,
          status: "applicable",
        },
        {
          checkId: "formatting",
          file: "src/value.ts",
          findingIds: ["format-warning", "lint-error", "lint-warning"],
          scope: "working-file",
          fixes: 1,
          blocking: 0,
          warnings: 1,
          status: "applicable",
        },
      ],
    });
    const textTerminal = io(false);
    await executeFixCommand(base, textTerminal, dependencies(prepared));
    const textOutput = textTerminal.stdout.join("");

    expect(textOutput).toContain("3 fixes across 1 file");
    expect(textOutput).toContain('lint: "src/value.ts" (finding, 2 fixes)');
    expect(textOutput).toContain(
      'formatting: "src/value.ts" (working-file, 1 fix)',
    );
    expect(textOutput).not.toContain("1 fixes");

    const jsonTerminal = io(false);
    await executeFixCommand(
      { ...base, format: "json" },
      jsonTerminal,
      dependencies(prepared),
    );
    const output = JSON.parse(jsonTerminal.stdout.join("")) as {
      summary: { fixes: number; blocking: number; warnings: number };
      files: Array<{ fixes: number }>;
      items: Array<{ checkId: string; fixes: number }>;
    };
    expect(output.summary).toMatchObject({
      fixes: 3,
      blocking: 1,
      warnings: 2,
    });
    expect(output.items).toEqual([
      expect.objectContaining({ checkId: "lint", fixes: 2 }),
      expect.objectContaining({ checkId: "formatting", fixes: 1 }),
    ]);
    expect(output.items.reduce((total, item) => total + item.fixes, 0)).toBe(3);
    expect(output.files[0]?.fixes).toBe(3);
  });

  it("returns a source-free JSON preview without applying", async () => {
    const terminal = io(false);
    const deps = dependencies(
      plan({
        items: [
          {
            checkId: "lint",
            file: "src/value.ts",
            findingIds: ["lint-1"],
            scope: "finding",
            blocking: 1,
            warnings: 0,
          },
        ],
      }),
    );

    await expect(
      executeFixCommand({ ...base, format: "json" }, terminal, deps),
    ).resolves.toBe(0);
    expect(JSON.parse(terminal.stdout.join(""))).toMatchObject({
      applied: false,
      items: [{ file: "src/value.ts", findingIds: ["lint-1"] }],
    });
    expect(terminal.stdout.join("")).not.toContain("baseSource");
    expect(deps.applyFixPlan).not.toHaveBeenCalled();
  });

  it("projects only approved public fields in a hostile JSON preview", async () => {
    const terminal = io(false);
    const deps = dependencies(hostilePlan());

    await expect(
      executeFixCommand({ ...base, format: "json" }, terminal, deps),
    ).resolves.toBe(0);

    expectPublicPlan(JSON.parse(terminal.stdout.join("")), false);
  });

  it("returns a JSON apply result and preserves partial success", async () => {
    const terminal = io(false);
    const deps = dependencies();
    deps.applyFixPlan = vi.fn(async () => ({
      exitCode: 1 as const,
      appliedFixes: 1,
      changedFiles: ["src/value.ts"],
      unchangedFiles: ["src/other.ts"],
      issues: [
        {
          kind: "stale" as const,
          file: "src/other.ts",
          checkIds: ["lint" as const],
          message: "The working file changed after Zedbee previewed it.",
          remediation: "Build a fresh fix plan and try again.",
        },
      ],
    }));

    await expect(
      executeFixCommand({ ...base, yes: true, format: "json" }, terminal, deps),
    ).resolves.toBe(1);
    expect(JSON.parse(terminal.stdout.join(""))).toMatchObject({
      applied: true,
      result: { appliedFixes: 1, unchangedFiles: ["src/other.ts"] },
    });
  });

  it.each([
    ["interactive approval", true],
    ["--yes", false],
  ])(
    "prints blocking and warning plan counts plus the review-stage-rescan next step after %s",
    async (_route, tty) => {
      const terminal = io(tty);
      const deps = dependencies(
        plan({
          summary: {
            fixes: 3,
            files: 2,
            blocking: 2,
            warnings: 1,
            skipped: 1,
          },
        }),
      );
      deps.applyFixPlan = vi.fn(async () => ({
        exitCode: 1 as const,
        appliedFixes: 2,
        changedFiles: ["src/value.ts"],
        unchangedFiles: ["src/other.ts"],
        issues: [
          {
            kind: "conflict" as const,
            file: "src/other.ts",
            checkIds: ["lint" as const],
            message: "Working changes overlap a managed exact fix.",
            remediation: "Resolve the overlapping edit and build a fresh plan.",
          },
        ],
      }));

      await expect(
        executeFixCommand({ ...base, yes: !tty }, terminal, deps),
      ).resolves.toBe(1);

      const output = terminal.stdout.join("");
      expect(output).toContain("Plan findings: 2 blocking; 1 warning");
      expect(output).toContain(
        "Next step: Review the working changes, stage the desired changes, then run zedbee scan again.",
      );
      expect(output).toContain("Working changes overlap a managed exact fix.");
    },
  );

  it("projects only approved public fields in a hostile applied JSON result", async () => {
    const terminal = io(false);
    const deps = dependencies(hostilePlan());
    deps.applyFixPlan = vi.fn(async () => ({
      exitCode: 0 as const,
      appliedFixes: 1,
      changedFiles: ["src/value.ts"],
      unchangedFiles: [],
      issues: [],
    }));

    await expect(
      executeFixCommand({ ...base, yes: true, format: "json" }, terminal, deps),
    ).resolves.toBe(0);

    expectPublicPlan(JSON.parse(terminal.stdout.join("")), true, {
      exitCode: 0,
      appliedFixes: 1,
      changedFiles: ["src/value.ts"],
      unchangedFiles: [],
      issues: [],
    });
  });

  it("returns status 2 for an untrustworthy plan without writing", async () => {
    const terminal = io(false);
    const deps = dependencies(plan({ exitCode: 2 }));

    await expect(
      executeFixCommand({ ...base, yes: true }, terminal, deps),
    ).resolves.toBe(2);
    expect(deps.applyFixPlan).not.toHaveBeenCalled();
  });

  it("persists an oversized source-free plan and prints maintenance warnings last", async () => {
    const terminal = io(false);
    const deps = dependencies(
      plan({
        items: Array.from({ length: 26 }, (_, index) => ({
          checkId: "lint" as const,
          file: `src/${index}.ts`,
          findingIds: [`lint-${index}`],
          scope: "finding" as const,
          blocking: 1,
          warnings: 0,
        })),
      }),
    );
    deps.store = {
      maintain: vi.fn(async () => ({
        reportPath: "/tmp/zedbee/fix.json",
        warnings: [
          {
            code: "TEMP_REPORT_CLEANUP_FAILED" as const,
            message: "could not clean up",
          },
        ],
      })),
    };

    await executeFixCommand(base, terminal, deps);

    expect(deps.store.maintain).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.not.stringContaining("baseSource"),
      }),
    );
    expect(terminal.stderr.join("")).toMatch(/could not clean up\n$/u);
  });

  it.each([
    ["preview", false],
    ["apply", true],
  ])(
    "does not persist a temporary sidecar for an oversized complete JSON %s",
    async (_route, yes) => {
      const terminal = io(false);
      const deps = dependencies(
        plan({
          items: Array.from({ length: 26 }, (_, index) => ({
            checkId: "lint" as const,
            file: `src/${index}.ts`,
            findingIds: [`lint-${index}`],
            scope: "finding" as const,
            blocking: 1,
            warnings: 0,
            status: "applicable" as const,
          })),
        }),
      );

      await executeFixCommand({ ...base, format: "json", yes }, terminal, deps);

      expect(deps.store.maintain).toHaveBeenCalledOnce();
      expect(deps.store.maintain).toHaveBeenCalledWith({
        repositoryRoot: "/repo",
        maxAgeMs: 86_400_000,
      });
      expect(JSON.parse(terminal.stdout.join(""))).toMatchObject({
        applied: yes,
        items: expect.arrayContaining([
          expect.objectContaining({ file: "src/25.ts" }),
        ]),
      });
    },
  );

  it("returns status 2 and a concise interruption message", async () => {
    const terminal = io(false);
    const controller = new AbortController();
    controller.abort();
    const deps = dependencies();

    await expect(
      executeFixCommand({ ...base, signal: controller.signal }, terminal, deps),
    ).resolves.toBe(2);
    expect(terminal.stderr.join("")).toBe("Zedbee fix was interrupted.\n");
  });
});

describe("fix CLI registration", () => {
  it("lists the optional managed selector exactly once in built help", async () => {
    const result = await execa(
      process.execPath,
      ["dist/cli.js", "fix", "--help"],
      {
        cwd: process.cwd(),
        reject: false,
        stdin: "ignore",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: zedbee fix [options] [check]");
    expect(result.stdout).not.toContain("[check] [check]");
  });
});
