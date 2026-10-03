import { expect, it } from "vitest";
import type { CheckResult } from "../../src/core/types.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { DEFAULT_ANALYSIS_SESSION_DEPENDENCIES } from "../../src/scan/analysis-session.js";
import { runMergeScan } from "../../src/scan/merge-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { createReport } from "../helpers/scan-report.js";

const skipped: CheckResult = {
  checkId: "types",
  target: ".",
  status: "skipped",
  durationMs: 0,
  findings: [],
  skipReason: "No applicable source files",
};

it.each([
  { name: "missing", checks: [], code: "MERGE_COMPARISON_INCOMPLETE" },
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
  },
])(
  "does not treat a skipped comparison as proof that a $name parent analysis passed",
  async ({ checks, code }) => {
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
      createReport({ baseline: incoming, checks }),
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
      outcome: "incomplete",
      exitCode: 2,
      mergeParents: [main, incoming],
      checks: [{ error: { code } }],
    });
  },
);
