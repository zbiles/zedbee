import { expect, it } from "vitest";
import { captureSelectedIndexComparison } from "../../src/git/selected-comparison.js";
import { changeSetFromMap } from "../../src/git/change-set.js";
import {
  INSTALLATION_MESSAGE,
  INSTALLATION_REMEDIATION,
} from "../../src/checks/installation-diagnostic.js";
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
  {
    name: "installation",
    checks: [
      {
        ...advisory,
        error: {
          code: "COMPARISON_INSTALLATION_UNAVAILABLE",
          message: "Package alpha is unavailable.",
          remediation: "Run npm ci from the repository root.",
        },
      },
    ],
    code: "COMPARISON_INSTALLATION_UNAVAILABLE",
    exit: 0,
  },
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
    const observed: CheckResult[] = [];
    let calls = 0;
    const report = await runMergeScan(
      {
        repositoryRoot: repo.root,
        merge: "auto",
        mergeEnvironment: {},
        onEvent(event) {
          if (event.type === "check-completed") observed.push(event.result);
        },
      },
      {
        ...DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
        evaluate: evaluatePolicy,
        now: () => new Date(),
      },
      async () => reports[calls++]!,
    );
    if (name === "installation") {
      expect(observed[0]?.error).toMatchObject({
        message: INSTALLATION_MESSAGE,
        remediation: INSTALLATION_REMEDIATION,
      });
      expect(report?.checks[0]?.error).toEqual(checks[0]!.error);
    }
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

it.each([false, true])(
  "settles sibling Git readers before releasing the index (abort=%s)",
  async (abort) => {
    const repo = await createGitRepository("zedbee-merge-readers-");
    await repo.write("a.txt", "one");
    await repo.commitAll("one");
    const first = (await repo.git(["rev-parse", "HEAD"])).stdout;
    await repo.write("a.txt", "two");
    await repo.commitAll("two");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const controller = new AbortController();
    const order: string[] = [];
    const outcome = runMergeScan(
      {
        repositoryRoot: repo.root,
        merge: "required",
        mergeEnvironment: { ["GITHEAD_" + first]: "one" },
        signal: controller.signal,
      },
      {
        ...DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
        evaluate: evaluatePolicy,
        now: () => new Date(),
        async captureIndexComparison(git, signal) {
          const selection = await captureSelectedIndexComparison(git, signal);
          return {
            ...selection,
            cleanup: async () => {
              order.push("cleanup");
              await selection.cleanup();
            },
          };
        },
        async readCommitChangeSet(_, parent) {
          if (parent !== first) throw Error("first parent failed");
          observed();
          await held;
          order.push("sibling settled");
          return changeSetFromMap(new Map());
        },
      },
      async () => {
        throw Error("unexpected parent scan");
      },
    );
    await started;
    if (abort) controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    release();
    if (abort) await expect(outcome).rejects.toThrow();
    else await expect(outcome).resolves.toMatchObject({ exitCode: 2 });
    expect(order).toEqual(["sibling settled", "cleanup"]);
  },
);