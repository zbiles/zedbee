import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitClient } from "../../src/git/client.js";
import {
  mergeLineRanges,
  readCommitChangeSet,
  readStagedChangeSet,
} from "../../src/git/change-set.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("readStagedChangeSet", () => {
  it("maps target additions to inclusive line ranges", async () => {
    const repository = await createGitRepository();
    await repository.write("src/value.ts", "line1\nline4\n");
    await repository.commitAll("base");
    await repository.write("src/value.ts", "line1\nline2\nline3\nline4\n");
    await repository.git(["add", "--", "src/value.ts"]);

    const changeSet = await readStagedChangeSet(new GitClient(repository.root));

    expect(changeSet.files.get("src/value.ts")).toEqual({
      path: "src/value.ts",
      status: "modified",
      addedRanges: [{ start: 2, end: 3 }],
    });
    expect(changeSet.containsAddedLine("src/value.ts", 2)).toBe(true);
    expect(changeSet.containsAddedLine("src/value.ts", 3)).toBe(true);
    expect(changeSet.containsAddedLine("src/value.ts", 4)).toBe(false);
    expect(changeSet.isEmpty).toBe(false);
  });

  it("represents additions, empty files, deletions, renames, spaces, and no final newline", async () => {
    const repository = await createGitRepository();
    await repository.write("rename-old.ts", "export const renamed = true;\n");
    await repository.write("delete.ts", "export const removed = true;\n");
    await repository.commitAll("base shapes");

    await repository.git(["mv", "rename-old.ts", "rename new.ts"]);
    await rm(join(repository.root, "delete.ts"));
    await repository.write(
      "path with spaces.ts",
      "export const finalLine = true;",
    );
    await repository.write("empty.ts", "");
    await repository.git(["add", "--all"]);

    const changeSet = await readStagedChangeSet(new GitClient(repository.root));

    expect([...changeSet.files.values()]).toEqual([
      {
        path: "delete.ts",
        status: "deleted",
        addedRanges: [],
      },
      {
        path: "empty.ts",
        status: "added",
        addedRanges: [],
      },
      {
        path: "path with spaces.ts",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
      {
        path: "rename new.ts",
        previousPath: "rename-old.ts",
        status: "renamed",
        addedRanges: [],
      },
    ]);
  });

  it("returns an empty change set when the index matches HEAD", async () => {
    const repository = await createGitRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.commitAll("base");

    const changeSet = await readStagedChangeSet(new GitClient(repository.root));

    expect(changeSet.isEmpty).toBe(true);
    expect([...changeSet.files]).toEqual([]);
    expect(changeSet.containsAddedLine("value.ts", 1)).toBe(false);
  });

  it("normalizes backslashes when querying a staged line", async () => {
    const repository = await createGitRepository();
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "src/value.ts"]);

    const changeSet = await readStagedChangeSet(new GitClient(repository.root));

    expect(changeSet.containsAddedLine("src\\value.ts", 1)).toBe(true);
  });

  it("excludes intent-to-add entries from the staged change set", async () => {
    const repository = await createGitRepository();
    await repository.write("intent.ts", "export const unstaged = true;\n");
    await repository.git(["add", "--intent-to-add", "--", "intent.ts"]);

    const changeSet = await readStagedChangeSet(new GitClient(repository.root));

    expect(changeSet.files.has("intent.ts")).toBe(false);
    expect(changeSet.isEmpty).toBe(true);
  });
});

describe("readCommitChangeSet", () => {
  it("reads only branch changes from an immutable commit pair", async () => {
    const repository = await createGitRepository();
    await repository.write("rename-old.ts", "line1\nline3\n");
    await repository.commitAll("base");
    await repository.git(["checkout", "-b", "feature"]);
    await repository.git(["mv", "rename-old.ts", "rename-new.ts"]);
    await repository.write("rename-new.ts", "line1\nline2\nline3\n");
    await repository.write("branch-only.ts", "export const branch = true;\n");
    await repository.commitAll("feature changes");
    const targetCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;

    await repository.git(["checkout", "main"]);
    await repository.write("main-only.ts", "export const main = true;\n");
    await repository.commitAll("main advances after divergence");
    const baselineCommit = (
      await repository.git(["merge-base", "main", "feature"])
    ).stdout;

    const changeSet = await readCommitChangeSet(
      new GitClient(repository.root),
      baselineCommit,
      targetCommit,
    );

    expect([...changeSet.files.values()]).toEqual([
      {
        path: "branch-only.ts",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
      {
        path: "rename-new.ts",
        previousPath: "rename-old.ts",
        status: "renamed",
        addedRanges: [{ start: 2, end: 2 }],
      },
    ]);
    expect(changeSet.files.has("main-only.ts")).toBe(false);
    expect(changeSet.containsAddedLine("rename-new.ts", 2)).toBe(true);
  });

  it("passes the validated commit IDs as separate diff arguments", async () => {
    const calls: string[][] = [];
    const git = {
      async run(args: readonly string[]) {
        calls.push([...args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as unknown as GitClient;

    await readCommitChangeSet(git, "baseline-oid", "target-oid");

    expect(calls).toEqual([
      [
        "diff",
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--end-of-options",
        "baseline-oid",
        "target-oid",
      ],
    ]);
  });

  it.each([
    ["staged", (git: GitClient) => readStagedChangeSet(git)],
    ["commit", (git: GitClient) =>
      readCommitChangeSet(git, "baseline-oid", "target-oid")],
  ])("fails closed when %s diff output is not a patch", async (_kind, read) => {
    const git = {
      async run() {
        return { stdout: "not Git diff output", stderr: "", exitCode: 0 };
      },
    } as unknown as GitClient;

    await expect(read(git)).rejects.toThrow("Git returned invalid diff output.");
  });

  it("fails closed when a diff hunk is truncated", async () => {
    const git = {
      async run() {
        return {
          stdout:
            "diff --git a/value.ts b/value.ts\nindex 1111111..2222222 100644\n--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n",
          stderr: "",
          exitCode: 0,
        };
      },
    } as unknown as GitClient;

    await expect(readStagedChangeSet(git)).rejects.toThrow(
      "Git returned invalid diff output.",
    );
  });
});

describe("mergeLineRanges", () => {
  it("merges overlapping and adjacent target ranges", () => {
    expect(
      mergeLineRanges([
        { start: 5, end: 5 },
        { start: 1, end: 1 },
        { start: 2, end: 3 },
        { start: 8, end: 9 },
        { start: 9, end: 10 },
      ]),
    ).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 5 },
      { start: 8, end: 10 },
    ]);
  });
});
