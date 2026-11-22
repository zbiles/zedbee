import { expect, it } from "vitest";
import type { CheckResult } from "../../src/core/types.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { DEFAULT_ANALYSIS_SESSION_DEPENDENCIES } from "../../src/scan/analysis-session.js";
import { runMergeScan } from "../../src/scan/merge-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { createReport } from "../helpers/scan-report.js";

const advisory: CheckResult = {
  checkId: "types",
  target: ".",
  status: "incomplete",
  durationMs: 0,
  findings: [],
  incompleteDisposition: "warn",
  error: {
    code: "ENGINE_FAILED",
    message: "The advisory check could not run.",
  },
};

const infrastructureFailure: CheckResult = {
  checkId: "zedbee",
  status: "incomplete",
  durationMs: 0,
  findings: [],
  error: {
    code: "CHECK_DISPATCH_FAILED",
    message: "The parent scan could not dispatch checks.",
  },
};

const skipped: CheckResult = {
  checkId: "types",
  target: ".",
  status: "skipped",
  durationMs: 0,
  findings: [],
  skipReason: "No applicable source files",
};

it.each([
  { name: "missing", checks: [], code: "MERGE_COMPARISON_INCOMPLETE", exit: 2 },
  { name: "advisory", checks: [advisory], code: "ENGINE_FAILED", exit: 0 },
  {
    name: "infrastructure",
    checks: [infrastructureFailure],
    code: "CHECK_DISPATCH_FAILED",
    exit: 2,
  },
  {
    name: "failed",
    checks: [
      {
        checkId: "types",
        target: ".",
        status: "incomplete",
        durationMs: 0,
        findings: [],
        incompleteDisposition: "block",
        error: {
          code: "ENGINE_FAILED",
          message: "The parent analyzer could not run.",
        },
      },
    ] satisfies CheckResult[],
    code: "ENGINE_FAILED",
    exit: 2,
  },
])(
  "preserves the $name parent check disposition in the merge",
  async ({ name, checks, code, exit }) => {
    const repo = await createGitRepository("zedbee-merge-failure-");
    await repo.write("base.txt", "base\n");
    await repo.commitAll("base");
    await repo.git(["branch", "incoming"]);
    await repo.write("main.txt", "main\n");
    await repo.commitAll("main");
    const main = (await repo.git(["rev-parse", "HEAD"])).stdout;
    await repo.git(["switch", "incoming"]);
    await repo.write("incoming.txt", "incoming\n");
    await repo.commitAll("incoming");
    const incoming = (await repo.git(["rev-parse", "HEAD"])).stdout;
    await repo.git(["switch", "main"]);
    expect(
      (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"]))
        .exitCode,
    ).toBe(0);
    const reports = [
      createReport({ baseline: main, checks: [skipped] }),
      createReport({
        baseline: incoming,
        checks,
        ...(name === "infrastructure"
          ? { outcome: "incomplete", exitCode: 2 }
          : {}),
      }),
    ];
    let calls = 0;
    const report = await runMergeScan(
      { repositoryRoot: repo.root, merge: "auto", mergeEnvironment: {} },
      {
        ...DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
        evaluate: evaluatePolicy,
        now: () => new Date(),
      },
      async () => reports[calls++]!,
    );
    expect(report).toMatchObject({
      outcome: exit === 0 ? "pass" : "incomplete",
      exitCode: exit,
      mergeParents: [main, incoming],
      checks: expect.arrayContaining([
        expect.objectContaining({ error: expect.objectContaining({ code }) }),
      ]),
    });
  },
);
