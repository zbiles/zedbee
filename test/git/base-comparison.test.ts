import { describe, expect, it } from "vitest";
import type { GitClient, GitOutput } from "../../src/git/client.js";
import {
  BaseComparisonError,
  resolveBaseComparison,
} from "../../src/git/base-comparison.js";

const SHA_BASE_TIP = "1111111111111111111111111111111111111111";
const SHA_TARGET = "2222222222222222222222222222222222222222";
const SHA_MERGE_BASE = "3333333333333333333333333333333333333333";

function gitReturning(outputs: readonly GitOutput[]) {
  const recordedArgs: string[][] = [];
  let index = 0;
  const git = {
    run: async (args: readonly string[]) => {
      recordedArgs.push([...args]);
      const output = outputs[index++];
      if (output === undefined) throw new Error("unexpected command");
      return output;
    },
  } as unknown as GitClient;
  return { git, recordedArgs };
}

function output(stdout: string, exitCode = 0, stderr = ""): GitOutput {
  return { stdout, stderr, exitCode };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("resolveBaseComparison", () => {
  it("resolves the requested ref, HEAD, and one merge base", async () => {
    const { git, recordedArgs } = gitReturning([
      output(`${SHA_BASE_TIP}\n`),
      output(`${SHA_TARGET}\n`),
      output(`${SHA_MERGE_BASE}\n`),
    ]);

    await expect(resolveBaseComparison(git, "origin/main")).resolves.toEqual({
      requestedBase: "origin/main",
      baselineCommit: SHA_MERGE_BASE,
      targetCommit: SHA_TARGET,
    });
    expect(recordedArgs).toEqual([
      ["rev-parse", "--verify", "--end-of-options", "origin/main^{commit}"],
      ["rev-parse", "--verify", "HEAD^{commit}"],
      ["merge-base", "--all", SHA_BASE_TIP, SHA_TARGET],
    ]);
  });

  it.each([
    ["", "empty input"],
    ["feature\0branch", "NUL"],
    ["feature\nbranch", "display controls"],
    [`feature\u0085branch`, "C1 display controls"],
    [`feature\u202Ebranch`, "bidi controls"],
    [`feature\u2066branch`, "bidi isolates"],
    [`feature\u2028branch`, "line separators"],
    [`feature\u2029branch`, "paragraph separators"],
    ["--upload-pack=evil", "option-looking refs"],
    ["a".repeat(257), "overlong input"],
  ])("rejects %s (%s) before invoking Git", async (requestedBase) => {
    const { git, recordedArgs } = gitReturning([]);
    await expectCode(
      resolveBaseComparison(git, requestedBase),
      "BASE_REF_INVALID",
    );
    expect(recordedArgs).toEqual([]);
  });

  it("reports an unavailable base ref without exposing Git output", async () => {
    const { git } = gitReturning([
      output("", 128, "fatal: secret-ref-details"),
    ]);
    const error = await resolveBaseComparison(git, "origin/main").catch(
      (value) => value,
    );
    expect(error).toBeInstanceOf(BaseComparisonError);
    expect(error).toMatchObject({ code: "BASE_REF_UNAVAILABLE" });
    expect(error.message).not.toContain("secret-ref-details");
    expect(error.message).not.toContain("origin/main");
  });

  it("reports an unborn HEAD", async () => {
    const { git } = gitReturning([
      output(`${SHA_BASE_TIP}\n`),
      output("", 128, "unborn"),
    ]);
    await expectCode(
      resolveBaseComparison(git, "origin/main"),
      "TARGET_COMMIT_UNAVAILABLE",
    );
  });

  it("rejects zero merge bases", async () => {
    const { git } = gitReturning([
      output(`${SHA_BASE_TIP}\n`),
      output(`${SHA_TARGET}\n`),
      output(""),
    ]);
    await expectCode(
      resolveBaseComparison(git, "origin/main"),
      "MERGE_BASE_UNAVAILABLE",
    );
  });

  it("rejects ambiguous merge bases", async () => {
    const { git } = gitReturning([
      output(`${SHA_BASE_TIP}\n`),
      output(`${SHA_TARGET}\n`),
      output(`${SHA_MERGE_BASE}\n${SHA_BASE_TIP}\n`),
    ]);
    await expectCode(
      resolveBaseComparison(git, "origin/main"),
      "MERGE_BASE_AMBIGUOUS",
    );
  });

  it.each([
    ["not-a-sha", "nonhex output"],
    [`${SHA_MERGE_BASE}\nextra`, "extra output lines"],
    [`${SHA_MERGE_BASE}\r\n`, "carriage return output"],
  ])("rejects malformed merge-base output (%s)", async (stdout) => {
    const { git } = gitReturning([
      output(`${SHA_BASE_TIP}\n`),
      output(`${SHA_TARGET}\n`),
      output(stdout),
    ]);
    await expectCode(
      resolveBaseComparison(git, "origin/main"),
      "REVISION_OUTPUT_INVALID",
    );
  });

  it("preserves abort errors", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    const git = {
      run: async () => {
        throw abortError;
      },
    } as unknown as GitClient;
    await expect(resolveBaseComparison(git, "origin/main")).rejects.toBe(
      abortError,
    );
  });

  it("passes the caller signal to each Git command", async () => {
    const signal = new AbortController().signal;
    const seen: (AbortSignal | undefined)[] = [];
    const git = {
      run: async (
        _args: readonly string[],
        options?: { signal?: AbortSignal },
      ) => {
        seen.push(options?.signal);
        return output(`${SHA_BASE_TIP}\n`);
      },
    } as unknown as GitClient;
    await resolveBaseComparison(git, "origin/main", signal);
    expect(seen).toEqual([signal, signal, signal]);
  });
});
