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

  it("reports a cancelled interactive plan without writing", async () => {
    const terminal = io(true);
    const deps = dependencies();
    deps.confirm = vi.fn(async () => false);

    await expect(executeFixCommand(base, terminal, deps)).resolves.toBe(0);
    expect(deps.applyFixPlan).not.toHaveBeenCalled();
    expect(terminal.stdout.join("")).toContain("Zedbee fix cancelled.");
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
