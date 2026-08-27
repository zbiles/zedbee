import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckExecutionResult } from "../../src/checks/adapter.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { CheckResult } from "../../src/core/types.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import { GitClient } from "../../src/git/client.js";
import type { SnapshotPair } from "../../src/git/snapshot.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
import {
  buildFixPlan,
  renderFixPlanJson,
  type BuildFixPlanDependencies,
} from "../../src/fixes/build-plan.js";

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
      summary: { fixes: 2, files: 1, blocking: 2, warnings: 0, skipped: 0 },
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
});
