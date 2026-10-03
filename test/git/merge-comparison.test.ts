import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { GitClient } from "../../src/git/client.js";
import {
  MergeComparisonError,
  resolveMergeComparison,
} from "../../src/git/merge-comparison.js";
import {
  createGitRepository,
  type TestGitRepository,
} from "../helpers/git-repository.js";

async function fixture() {
  const repository = await createGitRepository("zedbee-merge-parents-");
  await repository.write("value.txt", "base\n");
  await repository.commitAll("base");
  const head = (await repository.git(["rev-parse", "HEAD"])).stdout;
  await repository.git(["switch", "--create", "incoming"]);
  await repository.write("incoming.txt", "incoming\n");
  await repository.commitAll("incoming");
  const incoming = (await repository.git(["rev-parse", "HEAD"])).stdout;
  await repository.git(["switch", "main"]);
  return { repository, git: new GitClient(repository.root), head, incoming };
}

async function mergeHeadPath(repository: TestGitRepository) {
  const result = await repository.git([
    "rev-parse",
    "--git-path",
    "MERGE_HEAD",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  return isAbsolute(result.stdout)
    ? result.stdout
    : join(repository.root, result.stdout);
}

describe("resolveMergeComparison", () => {
  it("leaves an ordinary commit on the normal staged-scan path", async () => {
    const { git } = await fixture();
    await expect(
      resolveMergeComparison(git, {}, false),
    ).resolves.toBeUndefined();
  });

  it("reports unavailable parents when an explicit merge scan has no metadata", async () => {
    const { git } = await fixture();
    const error = await resolveMergeComparison(git, {}, true).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(MergeComparisonError);
    expect(error).toMatchObject({ code: "MERGE_PARENTS_UNAVAILABLE" });
  });

  it("uses incoming GITHEAD metadata before Git writes MERGE_HEAD", async () => {
    const { repository, git, head, incoming } = await fixture();
    await repository.write("value.txt", "staged result\n");
    await repository.git(["add", "--", "value.txt"]);
    const tree = (await repository.git(["write-tree"])).stdout;
    await repository.write("value.txt", "unstaged repair\n");

    await expect(
      resolveMergeComparison(
        git,
        { [`GITHEAD_${incoming}`]: "incoming" },
        true,
      ),
    ).resolves.toEqual({ parents: [head, incoming], tree });
    expect((await repository.git(["write-tree"])).stdout).toBe(tree);
    expect((await repository.git(["show", `${tree}:value.txt`])).stdout).toBe(
      "staged result",
    );
  });

  it("detects MERGE_HEAD during a normal commit without explicit merge mode", async () => {
    const { repository, git, head, incoming } = await fixture();
    await writeFile(await mergeHeadPath(repository), `${incoming}\n`);
    const tree = (await repository.git(["write-tree"])).stdout;

    await expect(resolveMergeComparison(git, {}, false)).resolves.toEqual({
      parents: [head, incoming],
      tree,
    });
  });

  it("keeps every incoming octopus parent from Git environment metadata", async () => {
    const { repository, git, head, incoming } = await fixture();
    await repository.git(["switch", "--create", "second"]);
    await repository.write("second.txt", "second parent\n");
    await repository.commitAll("second");
    const second = (await repository.git(["rev-parse", "HEAD"])).stdout;
    await repository.git(["switch", "main"]);

    const comparison = await resolveMergeComparison(
      git,
      {
        [`GITHEAD_${incoming}`]: "incoming",
        [`GITHEAD_${second}`]: "second",
      },
      true,
    );

    expect(comparison?.parents[0]).toBe(head);
    expect(comparison?.parents.slice(1)).toEqual(
      expect.arrayContaining([incoming, second]),
    );
    expect(comparison?.parents).toHaveLength(3);
  });

  it("keeps every octopus parent recorded in MERGE_HEAD", async () => {
    const { repository, git, head, incoming } = await fixture();
    await repository.git(["switch", "--create", "second"]);
    await repository.write("second.txt", "second parent\n");
    await repository.commitAll("second");
    const second = (await repository.git(["rev-parse", "HEAD"])).stdout;
    await repository.git(["switch", "main"]);
    await writeFile(
      await mergeHeadPath(repository),
      `${incoming}\n${second}\n`,
    );

    const comparison = await resolveMergeComparison(git, {}, true);

    expect(comparison?.parents).toEqual([head, incoming, second]);
  });

  it("deduplicates repeated merge parents", async () => {
    const { repository, git, head, incoming } = await fixture();
    await writeFile(
      await mergeHeadPath(repository),
      `${incoming}\n${head}\n${incoming}\n`,
    );

    expect((await resolveMergeComparison(git, {}, true))?.parents).toEqual([
      head,
      incoming,
    ]);
  });

  it("uses a linked worktree's merge metadata and staged index", async () => {
    const { repository, head, incoming } = await fixture();
    const worktree = await mkdtemp(join(tmpdir(), "zedbee-merge-worktree-"));
    onTestFinished(() => rm(worktree, { recursive: true, force: true }));
    const added = await repository.git([
      "worktree",
      "add",
      "-b",
      "linked-main",
      worktree,
      "main",
    ]);
    expect(added.exitCode, added.stderr).toBe(0);
    const git = new GitClient(worktree);
    const metadataPath = (
      await git.run(["rev-parse", "--git-path", "MERGE_HEAD"])
    ).stdout;
    await writeFile(metadataPath, `${incoming}\n`);
    await writeFile(
      await mergeHeadPath(repository),
      "invalid-common-metadata\n",
    );
    await writeFile(join(worktree, "value.txt"), "linked staged result\n");
    await git.run(["add", "--", "value.txt"]);
    const tree = (await git.run(["write-tree"])).stdout;

    await expect(resolveMergeComparison(git, {}, false)).resolves.toEqual({
      parents: [head, incoming],
      tree,
    });
    expect((await repository.git(["write-tree"])).stdout).not.toBe(tree);
  });

  it.each([
    ["", "empty metadata"],
    ["\n", "an empty parent"],
    ["incoming\n", "a branch name instead of an object ID"],
    ["--help\n", "an option-looking parent"],
    ["not-a-commit\n", "malformed metadata"],
    [`${"f".repeat(40)}\n`, "an unavailable object"],
  ])("rejects MERGE_HEAD containing %s (%s)", async (contents) => {
    const { repository, git } = await fixture();
    await writeFile(await mergeHeadPath(repository), contents);

    await expect(resolveMergeComparison(git, {}, false)).rejects.toMatchObject({
      code: "MERGE_PARENTS_INVALID",
    });
  });

  it.each([
    ["GITHEAD_", "empty parent ID"],
    ["GITHEAD_incoming", "a branch name"],
    ["GITHEAD_--help", "an option-looking parent"],
    [`GITHEAD_${"f".repeat(40)}`, "an unavailable object"],
  ])("rejects %s (%s) instead of scanning against HEAD alone", async (key) => {
    const { git } = await fixture();

    await expect(
      resolveMergeComparison(git, { [key]: "incoming" }, true),
    ).rejects.toMatchObject({ code: "MERGE_PARENTS_INVALID" });
  });

  it("rejects a tree object used as an incoming commit", async () => {
    const { repository, git } = await fixture();
    const tree = (await repository.git(["write-tree"])).stdout;

    await expect(
      resolveMergeComparison(git, { [`GITHEAD_${tree}`]: "incoming" }, true),
    ).rejects.toMatchObject({ code: "MERGE_PARENTS_INVALID" });
  });

  it("rejects an unresolved merge index instead of returning a partial tree", async () => {
    const { repository, git } = await fixture();
    await repository.git(["switch", "incoming"]);
    await repository.write("value.txt", "incoming resolution\n");
    await repository.commitAll("incoming conflict");
    await repository.git(["switch", "main"]);
    await repository.write("value.txt", "main resolution\n");
    await repository.commitAll("main conflict");
    const merged = await repository.git([
      "merge",
      "--no-commit",
      "--no-ff",
      "incoming",
    ]);
    expect(merged.exitCode).not.toBe(0);
    expect((await repository.git(["ls-files", "--unmerged"])).stdout).not.toBe(
      "",
    );

    await expect(resolveMergeComparison(git, {}, true)).rejects.toMatchObject({
      code: "MERGE_INDEX_UNRESOLVED",
    });
  });

  it("respects cancellation while resolving merge metadata", async () => {
    const { git, incoming } = await fixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveMergeComparison(
        git,
        { [`GITHEAD_${incoming}`]: "incoming" },
        true,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "GIT_ABORTED" });
  });
});
