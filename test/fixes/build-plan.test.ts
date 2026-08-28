import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckExecutionResult } from "../../src/checks/adapter.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { CheckResult } from "../../src/core/types.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import { GitClient } from "../../src/git/client.js";
import {
  buildSnapshotPair,
  type SnapshotPair,
} from "../../src/git/snapshot.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
import {
  buildFixPlan,
  FixPlanCleanupError,
  renderFixPlanJson,
  type BuildFixPlanDependencies,
} from "../../src/fixes/build-plan.js";
import { applyFixPlan } from "../../src/fixes/apply-plan.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";
import { createGitRepository } from "../helpers/git-repository.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const config: ResolvedConfig = resolveConfig({
  schemaVersion: 1,
  profile: "recommended",
  checks: {
    formatting: "error",
    lint: "error",
    reactCorrectness: "warn",
  },
});

const changeSet: ChangeSet = {
  files: new Map([
    [
      "src/value.ts",
      {
        path: "src/value.ts",
        status: "modified",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ],
  ]),
  isEmpty: false,
  containsAddedLine: () => true,
};

const inspection = (snapshotRoot: string): RepositoryInspection => ({
  snapshotRoot,
  packageManager: "npm",
  lockfiles: [],
  workspaces: [
    {
      relativeRoot: ".",
      manifestPath: "package.json",
      sourceFiles: ["src/value.ts"],
      tsconfigPaths: [],
      environments: ["typescript"],
      dependencyDeclarations: [],
    },
  ],
});

const completed: CheckResult = {
  checkId: "lint",
  target: ".",
  status: "completed",
  durationMs: 1,
  findings: [],
};

async function fixture(): Promise<{
  root: string;
  target: string;
  baseline: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-fix-plan-test-"));
  directories.push(root);
  const target = join(root, "target");
  const baseline = join(root, "baseline");
  await Promise.all([
    mkdir(join(root, "src"), { recursive: true }),
    mkdir(target),
    mkdir(baseline),
  ]);
  await writeFile(join(root, "src", "value.ts"), "const answer=42\n");
  return { root, target, baseline };
}

function planDependencies(
  fixture: { root: string; target: string; baseline: string },
  calls: string[],
  overrides: Partial<BuildFixPlanDependencies> = {},
): BuildFixPlanDependencies {
  const snapshots: SnapshotPair = {
    baselineDir: fixture.baseline,
    targetDir: fixture.target,
    baselineRef: "HEAD",
    unsupportedEntries: [],
    cleanup: async () => {
      calls.push("cleanup");
    },
  };
  return {
    loadConfig: async () => config,
    createGitClient: (root) => new GitClient(root),
    readChangeSet: async () => changeSet,
    buildSnapshots: async () => snapshots,
    inspectRepository: async (snapshotRoot) => inspection(snapshotRoot),
    dispatch: async (_adapters, context, options) => {
      expect(options?.collectFixes).toBe(true);
      expect(options?.cache).toBeUndefined();
      expect(context.config).toBe(config);
      return [
        {
          result: completed,
          policy: config.checks.lint,
          target: { id: ".", kind: "repository", relativeRoot: "." },
          policyForFile: (checkId, _path) => config.checks[checkId],
          fixCandidates: [
            {
              kind: "exact-file",
              checkId: "lint",
              file: "src/value.ts",
              baseSource: "const answer=42\n",
              edits: [
                {
                  findingId: "lint-finding",
                  severity: "error",
                  start: 6,
                  end: 12,
                  replacement: "result",
                },
              ],
            },
          ],
        } satisfies CheckExecutionResult,
      ];
    },
    evaluate: () => ({
      exitCode: 0,
      outcome: "pass",
      results: [completed],
      summary: {
        passed: 1,
        warnings: 0,
        failed: 0,
        incomplete: 0,
        findings: [],
      },
    }),
    adapters: [
      { id: "formatting" } as never,
      { id: "lint" } as never,
      { id: "reactCorrectness" } as never,
      { id: "types" } as never,
    ],
    hasUnstagedChanges: async () => false,
    ...overrides,
  };
}

describe("buildFixPlan", () => {
  it("builds a deeply immutable source-free plan from a fresh fix-collecting staged analysis", async () => {
    const files = await fixture();
    const calls: string[] = [];

    const plan = await buildFixPlan({
      repositoryRoot: files.root,
      selectedChecks: ["formatting", "lint", "reactCorrectness"],
      dependencies: planDependencies(files, calls),
    });

    expect(plan.publicPlan).toMatchObject({
      schemaVersion: 1,
      target: "index",
      selectedChecks: ["formatting", "lint", "reactCorrectness"],
      summary: { fixes: 2, files: 1, blocking: 1, warnings: 0, skipped: 0 },
    });
    expect(plan.publicPlan.items).toEqual([
      expect.objectContaining({ checkId: "formatting", scope: "working-file" }),
      expect.objectContaining({ checkId: "lint", scope: "finding" }),
    ]);
    expect(plan.workingFiles.get("src/value.ts")).toMatchObject({
      content: "const answer=42\n",
      hasUnstagedChanges: false,
    });
    expect(Object.isFrozen(plan.publicPlan)).toBe(true);
    expect(Object.isFrozen(plan.publicPlan.items)).toBe(true);
    expect(calls).toEqual(["cleanup"]);

    const json = renderFixPlanJson(plan.publicPlan);
    expect(json).not.toContain("baseSource");
    expect(json).not.toContain("replacement");
    expect(json).not.toContain(files.root);

    const hostileJson = renderFixPlanJson({
      ...plan.publicPlan,
      baseSource: "do not serialize source",
      replacement: "do not serialize replacement",
      repositoryRoot: files.root,
    } as typeof plan.publicPlan);
    expect(hostileJson).not.toContain("do not serialize");
    expect(hostileJson).not.toContain(files.root);
  });

  it("cleans snapshots when a provider result is incomplete", async () => {
    const files = await fixture();
    const calls: string[] = [];
    const incomplete: CheckExecutionResult = {
      result: {
        checkId: "lint",
        status: "incomplete",
        durationMs: 1,
        findings: [],
      },
      policy: config.checks.lint,
      fixCandidates: [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "src/value.ts",
          baseSource: "const answer=42\n",
          edits: [
            {
              findingId: "unusable-finding",
              severity: "error",
              start: 6,
              end: 12,
              replacement: "result",
            },
          ],
        },
      ],
    };

    const plan = await buildFixPlan({
      repositoryRoot: files.root,
      selectedChecks: ["lint"],
      dependencies: planDependencies(files, calls, {
        dispatch: async () => [incomplete],
      }),
    });

    expect(plan.publicPlan.exitCode).toBe(2);
    expect(plan.publicPlan.items).toEqual([]);
    expect(calls).toEqual(["cleanup"]);
  });

  it("dispatches only the strictly selected supported check", async () => {
    const files = await fixture();
    const calls: string[] = [];

    const plan = await buildFixPlan({
      repositoryRoot: files.root,
      selectedChecks: ["lint"],
      dependencies: planDependencies(files, calls, {
        dispatch: async (adapters) => {
          expect(adapters.map((adapter) => adapter.id)).toEqual(["lint"]);
          return [];
        },
      }),
    });

    expect(plan.publicPlan).toMatchObject({
      selectedChecks: ["lint"],
      summary: { fixes: 0, files: 0, blocking: 0, warnings: 0, skipped: 0 },
    });
    expect(calls).toEqual(["cleanup"]);
  });

  it("cleans snapshots before rejecting unsupported staged input", async () => {
    const files = await fixture();
    const calls: string[] = [];

    await expect(
      buildFixPlan({
        repositoryRoot: files.root,
        selectedChecks: ["lint"],
        dependencies: planDependencies(files, calls, {
          buildSnapshots: async () => ({
            baselineDir: files.baseline,
            targetDir: files.target,
            baselineRef: "HEAD",
            unsupportedEntries: [{ path: "src/value.ts", kind: "binary" }],
            cleanup: async () => {
              calls.push("cleanup");
            },
          }),
        }),
      }),
    ).rejects.toThrow("unsupported staged input");
    expect(calls).toEqual(["cleanup"]);
  });

  it("cleans snapshots when aborted after snapshot construction", async () => {
    const files = await fixture();
    const calls: string[] = [];
    const controller = new AbortController();

    await expect(
      buildFixPlan({
        repositoryRoot: files.root,
        selectedChecks: ["lint"],
        signal: controller.signal,
        dependencies: planDependencies(files, calls, {
          inspectRepository: async () => {
            controller.abort(new Error("cancelled"));
            return inspection(files.target);
          },
        }),
      }),
    ).rejects.toThrow("cancelled");
    expect(calls).toEqual(["cleanup"]);
  });

  it("does not construct a snapshot when configuration loading fails", async () => {
    const files = await fixture();
    const calls: string[] = [];

    await expect(
      buildFixPlan({
        repositoryRoot: files.root,
        selectedChecks: ["lint"],
        dependencies: planDependencies(files, calls, {
          loadConfig: async () => {
            throw new Error("invalid config");
          },
          buildSnapshots: async () => {
            calls.push("build");
            throw new Error("not reached");
          },
        }),
      }),
    ).rejects.toThrow("invalid config");
    expect(calls).toEqual([]);
  });

  it("rejects a non-fixable runtime selector at the builder boundary", async () => {
    const files = await fixture();

    await expect(
      buildFixPlan({
        repositoryRoot: files.root,
        selectedChecks: ["types" as "lint"],
        dependencies: planDependencies(files, []),
      }),
    ).rejects.toThrow("supported managed fix check");
  });

  it("collects staged formatter and lint fixes without changing index or working bytes", async () => {
    const repository = await createGitRepository(
      "zedbee-fix-plan-integration-",
    );
    const clean = "export const value = 1;\n";
    const staged = "export const value = 1;;\n";
    const working = "export const value = 1;;;\n";
    await repository.write(
      "package.json",
      '{"name":"fixture","private":true}\n',
    );
    await repository.write("src/value.js", clean);
    await repository.commitAll("baseline");
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: {
          formatting: "error",
          lint: {
            severity: "warn",
            rules: { "no-extra-semi": "error" },
          },
          reactCorrectness: "off",
        },
      }),
    );
    await repository.write("src/value.js", staged);
    await repository.git(["add", "--", "src/value.js"]);
    await repository.write("src/value.js", working);
    const beforeIndex = await repository.git(["show", ":src/value.js"]);
    const beforeStatus = await repository.git(["status", "--porcelain"]);

    const plan = await buildFixPlan({
      repositoryRoot: repository.root,
      selectedChecks: ["formatting", "lint"],
    });

    expect(plan.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "exact-file",
          checkId: "lint",
          file: "src/value.js",
          baseSource: staged,
        }),
        expect.objectContaining({
          kind: "format-file",
          checkId: "formatting",
          file: "src/value.js",
        }),
      ]),
    );
    expect(plan.publicPlan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "lint", warnings: 1 }),
        expect.objectContaining({ checkId: "formatting" }),
      ]),
    );
    expect(plan.workingFiles.get("src/value.js")).toMatchObject({
      content: working,
      hasUnstagedChanges: true,
    });
    await expect(repository.read("src/value.js")).resolves.toBe(working);
    await expect(repository.git(["show", ":src/value.js"])).resolves.toEqual(
      beforeIndex,
    );
    await expect(repository.git(["status", "--porcelain"])).resolves.toEqual(
      beforeStatus,
    );
  });

  it("shows an existing exact-edit overlap in the public plan while a safe Git file remains applicable", async () => {
    const repository = await createGitRepository("zedbee-fix-overlap-plan-");
    const clean = "export const value = 1;\n";
    const staged = "export const value = 1;;\n";
    const overlappingWorking = "export const value = 1; /* mine */\n";
    await repository.write(
      "package.json",
      '{"name":"fixture","private":true}\n',
    );
    await repository.write("src/safe.js", clean);
    await repository.write("src/overlap.js", clean);
    await repository.commitAll("baseline");
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: {
          formatting: "off",
          lint: {
            severity: "error",
            rules: { "no-extra-semi": "error" },
          },
          reactCorrectness: "off",
        },
      }),
    );
    await repository.write("src/safe.js", staged);
    await repository.write("src/overlap.js", staged);
    await repository.git(["add", "--", "src/safe.js", "src/overlap.js"]);
    await repository.write("src/overlap.js", overlappingWorking);

    const prepared = await buildFixPlan({
      repositoryRoot: repository.root,
      selectedChecks: ["lint"],
    });

    expect(prepared.publicPlan.summary).toMatchObject({ fixes: 2, skipped: 1 });
    expect(prepared.publicPlan.files).toEqual([
      expect.objectContaining({
        path: "src/overlap.js",
        applicableFixes: 0,
        skippedFixes: 1,
        status: "skipped",
        reasons: ["Working changes overlap a managed exact fix."],
      }),
      expect.objectContaining({
        path: "src/safe.js",
        applicableFixes: 1,
        skippedFixes: 0,
        status: "applicable",
        reasons: [],
      }),
    ]);
    expect(prepared.publicPlan.items).toEqual([
      expect.objectContaining({
        file: "src/overlap.js",
        status: "skipped",
        reason: "Working changes overlap a managed exact fix.",
      }),
      expect.objectContaining({ file: "src/safe.js", status: "applicable" }),
    ]);

    const result = await applyFixPlan(prepared);
    expect(result).toMatchObject({
      exitCode: 1,
      appliedFixes: 1,
      changedFiles: ["src/safe.js"],
      unchangedFiles: ["src/overlap.js"],
      issues: [
        expect.objectContaining({ kind: "conflict", file: "src/overlap.js" }),
      ],
    });
    await expect(repository.read("src/safe.js")).resolves.toBe(clean);
    await expect(repository.read("src/overlap.js")).resolves.toBe(
      overlappingWorking,
    );
  });

  it("reconciles each exact edit and one formatting action with the applied fix count", async () => {
    const files = await fixture();
    const source = "const one=1;;\nconst two=2;;\n";
    await writeFile(join(files.root, "src", "value.ts"), source);
    const firstExtra = source.indexOf(";;") + 1;
    const secondExtra = source.lastIndexOf(";;") + 1;
    const dependencies = planDependencies(files, [], {
      dispatch: async () => [
        {
          result: completed,
          policy: config.checks.lint,
          target: { id: ".", kind: "repository", relativeRoot: "." },
          policyForFile: (checkId, _path) => config.checks[checkId],
          fixCandidates: [
            {
              kind: "exact-file",
              checkId: "lint",
              file: "src/value.ts",
              baseSource: source,
              edits: [
                {
                  findingId: "first",
                  severity: "error",
                  start: firstExtra,
                  end: firstExtra + 1,
                  replacement: "",
                },
                {
                  findingId: "second",
                  severity: "warning",
                  start: secondExtra,
                  end: secondExtra + 1,
                  replacement: "",
                },
              ],
            },
            {
              kind: "format-file",
              checkId: "formatting",
              file: "src/value.ts",
              findingIds: ["format-only"],
              severities: ["warning"],
              settings: DEFAULT_FORMATTING_SETTINGS,
            },
          ],
        },
      ],
    });

    const prepared = await buildFixPlan({
      repositoryRoot: files.root,
      selectedChecks: ["formatting", "lint"],
      dependencies,
    });
    const result = await applyFixPlan(prepared);

    expect(prepared.publicPlan.summary).toEqual({
      fixes: 3,
      files: 1,
      blocking: 1,
      warnings: 2,
      skipped: 0,
    });
    expect(prepared.publicPlan.items).toEqual([
      expect.objectContaining({
        checkId: "formatting",
        fixes: 1,
        blocking: 0,
        warnings: 1,
      }),
      expect.objectContaining({
        checkId: "lint",
        findingIds: ["first", "second"],
        fixes: 2,
        blocking: 1,
        warnings: 1,
      }),
    ]);
    expect(
      prepared.publicPlan.items.reduce(
        (total, item) => total + (item.fixes ?? 0),
        0,
      ),
    ).toBe(prepared.publicPlan.summary.fixes);
    expect(result.appliedFixes).toBe(prepared.publicPlan.summary.fixes);
    await expect(
      readFile(join(files.root, "src", "value.ts"), "utf8"),
    ).resolves.toBe("const one = 1;\nconst two = 2;\n");
  });

  it("reports an actionable snapshot path when final cleanup fails", async () => {
    const repository = await createGitRepository("zedbee-fix-plan-cleanup-");
    await repository.write(
      "package.json",
      '{"name":"fixture","private":true}\n',
    );
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.commitAll("baseline");
    await repository.write("src/value.ts", "export const value = 2;\n");
    await repository.git(["add", "--", "src/value.ts"]);
    const git = new GitClient(repository.root);
    const pair = await buildSnapshotPair(repository.root, git);
    const calls: string[] = [];

    try {
      await expect(
        buildFixPlan({
          repositoryRoot: repository.root,
          selectedChecks: ["lint"],
          dependencies: planDependencies(
            {
              root: repository.root,
              baseline: pair.baselineDir,
              target: pair.targetDir,
            },
            calls,
            {
              buildSnapshots: async () => ({
                ...pair,
                cleanup: async () => {
                  calls.push("cleanup");
                  throw new Error("injected cleanup failure");
                },
              }),
            },
          ),
        }),
      ).rejects.toMatchObject({
        name: FixPlanCleanupError.name,
        temporaryPath: dirname(pair.targetDir),
      });
      expect(calls).toEqual(["cleanup"]);
    } finally {
      await pair.cleanup();
    }
  });
});
