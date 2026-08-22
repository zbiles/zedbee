import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckAdapter } from "../../src/checks/adapter.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type {
  ResolvedComplexityPolicy,
  ResolvedDuplicationPolicy,
} from "../../src/config/schema.js";
import type { Observation } from "../../src/core/types.js";
import { readStagedChangeSet } from "../../src/git/change-set.js";
import { GitClient } from "../../src/git/client.js";
import { buildSnapshotPair } from "../../src/git/snapshot.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { runScan, type RunScanDependencies } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

const CHECK_ID = "cyclomaticComplexity";
const ENTITY_ID = "function:src/parser.ts:parseOrder";

function issue(rule: string, line: number): Observation {
  return {
    check: CHECK_ID,
    rule,
    identity: `${rule}:src/parser.ts:${line}`,
    severity: "error",
    message: `${rule} diagnostic`,
    location: { file: "src/parser.ts", startLine: line, endLine: line },
  };
}

function metric(value: number): Observation {
  return {
    check: CHECK_ID,
    rule: "cyclomatic-complexity",
    identity: ENTITY_ID,
    severity: "error",
    message: "Function complexity exceeds policy.",
    entity: { kind: "function", name: "parseOrder", file: "src/parser.ts" },
    metric: { name: "cyclomatic-complexity", value },
  };
}

function entityIssue(): Observation {
  return {
    check: CHECK_ID,
    rule: "changed-function-shape",
    identity: ENTITY_ID,
    severity: "error",
    message: "Changed function has a structural issue.",
    entity: { kind: "function", name: "parseOrder", file: "src/parser.ts" },
  };
}

function repositoryIssue(): Observation {
  return {
    check: CHECK_ID,
    rule: "dependency-cycle",
    identity: "dependency-cycle:parser->core",
    severity: "error",
    message: "The staged repository graph introduces a cycle.",
  };
}

describe("attribution platform", () => {
  it("blocks only a new staged range issue and a worsened changed-entity metric", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "src/parser.ts",
      [
        "export function parseOrder(value: number) {",
        "  if (value > 0) {",
        "    return value;",
        "  }",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    );
    await repository.commitAll("baseline parser");
    await repository.write(
      "src/parser.ts",
      [
        "export function parseOrder(value: number) {",
        "  if (value > 0) {",
        "    return value;",
        "  }",
        "  if (value < 0) {",
        "    return -value;",
        "  }",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    );
    await repository.git(["add", "--", "src/parser.ts"]);
    await repository.write(
      "src/parser.ts",
      `${await readFile(join(repository.root, "src/parser.ts"), "utf8")}export const liveOnly = unknownValue;\n`,
    );

    let targetSource = "";
    const adapter = {
      id: CHECK_ID,
      output: "observations",
      inspect: async () => ({
        applies: true as const,
        executionClass: "lightweight" as const,
        requiresBaseline: true,
        targets: [{ id: ".", kind: "repository" as const, relativeRoot: "." }],
      }),
      collect: async (context) => {
        const policy = context.policy as ResolvedComplexityPolicy;
        policy.max = 100;
        policy.blockWorsening = false;
        targetSource = await readFile(
          join(context.snapshots.targetDir, "src/parser.ts"),
          "utf8",
        );
        const existing = issue("existing-issue", 2);
        return {
          checkId: CHECK_ID,
          target: context.target,
          baselineObservations: [existing, metric(25)],
          targetObservations: [
            existing,
            issue("new-branch", 6),
            issue("target-only-unchanged-line", 2),
            {
              ...issue("path-only-file-finding", 2),
              location: { file: "src/parser.ts" },
            },
            entityIssue(),
            repositoryIssue(),
            metric(26),
            ...(targetSource.includes("liveOnly")
              ? [issue("unstaged-live-tree-issue", 10)]
              : []),
          ],
        };
      },
    } satisfies CheckAdapter;
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: {
        cyclomaticComplexity: {
          severity: "error",
          max: 20,
          blockWorsening: true,
        },
      },
    });
    const git = new GitClient(repository.root);
    let tick = 0;
    const dependencies: RunScanDependencies = {
      loadConfig: async () => config,
      createGitClient: () => git,
      readChangeSet: readStagedChangeSet,
      buildSnapshots: buildSnapshotPair,
      inspectRepository,
      baselineForEmptyChange: async () => "HEAD",
      dispatch: dispatchChecks,
      evaluate: evaluatePolicy,
      adapters: [adapter],
      now: () => new Date("2026-08-15T00:00:00.000Z"),
      clock: () => tick++,
    };

    const report = await runScan({
      repositoryRoot: repository.root,
      dependencies,
    });

    expect(targetSource).not.toContain("liveOnly");
    expect(report).toMatchObject({ outcome: "blocked", exitCode: 1 });
    expect(report.summary.findings).toHaveLength(5);
    expect(report.summary.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "new-branch",
          attribution: expect.objectContaining({
            kind: "range-overlap",
            staged: true,
          }),
        }),
        expect.objectContaining({
          rule: "cyclomatic-complexity",
          attribution: expect.objectContaining({
            kind: "metric-delta",
            staged: true,
          }),
        }),
        expect.objectContaining({
          rule: "changed-function-shape",
          attribution: expect.objectContaining({
            kind: "syntax-ownership",
            staged: true,
          }),
        }),
        expect.objectContaining({
          rule: "dependency-cycle",
          attribution: expect.objectContaining({
            kind: "baseline-comparison",
            staged: true,
          }),
        }),
        expect.objectContaining({
          rule: "path-only-file-finding",
          attribution: expect.objectContaining({
            kind: "baseline-comparison",
            staged: true,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toMatch(
      /existing-issue|target-only-unchanged-line|unstaged-live-tree-issue/,
    );
  });

  it("uses a workspace duplication threshold override instead of an adapter metric limit", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "package.json",
      `${JSON.stringify({ name: "root", workspaces: ["packages/*"] })}\n`,
    );
    await repository.write(
      "packages/dup/package.json",
      `${JSON.stringify({ name: "dup" })}\n`,
    );
    await repository.write(
      "packages/dup/src/index.ts",
      "export function measure() { return 1; }\n",
    );
    await repository.commitAll("baseline workspace");
    await repository.write(
      "packages/dup/src/index.ts",
      "export function measure() { return 2; }\n",
    );
    await repository.git(["add", "--", "packages/dup/src/index.ts"]);

    const adapter = {
      id: "duplication",
      output: "observations",
      inspect: async () => ({
        applies: true as const,
        executionClass: "project-analysis" as const,
        requiresBaseline: true,
        targets: [
          {
            id: "packages/dup",
            kind: "workspace" as const,
            relativeRoot: "packages/dup",
          },
        ],
      }),
      collect: async (context) => {
        (context.policy as ResolvedDuplicationPolicy).threshold = 100;
        return {
          checkId: "duplication",
          target: context.target,
          baselineObservations: [],
          targetObservations: [
            {
              check: "duplication",
              rule: "duplicate-density",
              identity: "function:packages/dup/src/index.ts:measure",
              severity: "error" as const,
              message: "Duplicate density exceeds policy.",
              entity: {
                kind: "function",
                name: "measure",
                file: "packages/dup/src/index.ts",
              },
              metric: { name: "duplicate-density", value: 12, limit: 100 },
            },
          ],
        };
      },
    } satisfies CheckAdapter;
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "thorough",
      checks: {
        duplication: { severity: "error", threshold: 50 },
      },
      overrides: [
        {
          files: ["packages/dup/**"],
          checks: { duplication: { threshold: 10 } },
        },
      ],
    });
    const git = new GitClient(repository.root);
    let tick = 0;
    const dependencies: RunScanDependencies = {
      loadConfig: async () => config,
      createGitClient: () => git,
      readChangeSet: readStagedChangeSet,
      buildSnapshots: buildSnapshotPair,
      inspectRepository,
      baselineForEmptyChange: async () => "HEAD",
      dispatch: dispatchChecks,
      evaluate: evaluatePolicy,
      adapters: [adapter],
      now: () => new Date("2026-08-15T00:00:00.000Z"),
      clock: () => tick++,
    };

    const report = await runScan({
      repositoryRoot: repository.root,
      dependencies,
    });

    expect(report).toMatchObject({ outcome: "blocked", exitCode: 1 });
    expect(report.summary.findings).toEqual([
      expect.objectContaining({
        check: "duplication",
        attribution: {
          kind: "metric-delta",
          staged: true,
          evidence: expect.arrayContaining(["limit:10", "target-value:12"]),
        },
      }),
    ]);
  });
});
