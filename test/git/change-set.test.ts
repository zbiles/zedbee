import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitClient } from "../../src/git/client.js";
import {
  mergeLineRanges,
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

  it("represents intent-to-add entries so scan preflight cannot miss them", async () => {
    const repository = await createGitRepository();
    await repository.write("future file.ts", "export const future = true;\n");
    await repository.git(["add", "--intent-to-add", "--", "future file.ts"]);

    const changeSet = await readStagedChangeSet(new GitClient(repository.root));

    expect(changeSet.isEmpty).toBe(false);
    expect(changeSet.files.get("future file.ts")).toEqual({
      path: "future file.ts",
      status: "added",
      addedRanges: [],
    });
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
