import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitClient } from "../../src/git/client.js";
import {
  addCommitLineRanges,
  addStagedLineRanges,
  discoverStagedChangeSet,
  addWholeFileLineRanges,
  type ChangeSet,
  discoverCommitChangeSet,
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

  it.skipIf(process.platform === "win32")(
    "adds text ranges after bounded commit metadata without changing rename status",
    async () => {
      const repository = await createGitRepository();
      await repository.write("old.ts", "line1\nline3\n");
      await repository.write(":(literal)magic.ts", "before\n");
      await repository.commitAll("baseline");
      const baselineCommit = (await repository.git(["rev-parse", "HEAD"]))
        .stdout;
      await repository.git(["mv", "old.ts", "new.ts"]);
      await repository.write("new.ts", "line1\nline2\nline3\n");
      await repository.write(":(literal)magic.ts", "after\n");
      await repository.commitAll("target");
      const targetCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;
      const git = new GitClient(repository.root);

      const metadata = await discoverCommitChangeSet(
        git,
        baselineCommit,
        targetCommit,
      );
      expect(metadata.files.get("new.ts")).toEqual({
        path: "new.ts",
        previousPath: "old.ts",
        status: "renamed",
        addedRanges: [],
      });

      const changeSet = await addCommitLineRanges(
        git,
        metadata,
        new Set(),
        baselineCommit,
        targetCommit,
      );
      expect(changeSet.files.get("new.ts")).toEqual({
        path: "new.ts",
        previousPath: "old.ts",
        status: "renamed",
        addedRanges: [{ start: 2, end: 2 }],
      });
      expect(changeSet.files.get(":(literal)magic.ts")?.addedRanges).toEqual([
        { start: 1, end: 1 },
      ]);
    },
  );

  it("passes the validated commit IDs to an attribute-insensitive diff", async () => {
    const calls: Array<{
      args: string[];
      options: { readonly env?: Readonly<Record<string, string>> } | undefined;
    }> = [];
    const git = {
      async run(
        args: readonly string[],
        options?: { readonly env?: Readonly<Record<string, string>> },
      ) {
        calls.push({ args: [...args], options });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as unknown as GitClient;

    await readCommitChangeSet(git, "baseline-oid", "target-oid");

    expect(calls).toEqual([
      {
        args: [
          "diff",
          "--no-relative",
          "--ignore-submodules=none",
          "--submodule=short",
          "--unified=0",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--text",
          "--diff-algorithm=myers",
          "--indent-heuristic",
          "--find-renames=50%",
          "-l0",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--end-of-options",
          "baseline-oid",
          "target-oid",
        ],
        options: { env: { GIT_ATTR_SOURCE: "target-oid" } },
      },
    ]);
  });

  it("does not let repository config hide staged or committed gitlink changes", async () => {
    const repository = await createGitRepository();
    await repository.write("root.ts", "export const root = 1;\n");
    await repository.commitAll("root");
    const firstCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;
    await repository.git([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${firstCommit},vendor/demo`,
    ]);
    await repository.git(["commit", "--message", "baseline gitlink"]);
    const baselineCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;
    await repository.git([
      "update-index",
      "--cacheinfo",
      `160000,${baselineCommit},vendor/demo`,
    ]);
    await repository.git(["config", "diff.ignoreSubmodules", "all"]);
    await repository.git(["config", "diff.submodule", "log"]);
    const client = new GitClient(repository.root);

    expect((await readStagedChangeSet(client)).files.has("vendor/demo")).toBe(
      true,
    );

    await repository.git(["commit", "--message", "target gitlink"]);
    const targetCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;
    expect(
      (
        await readCommitChangeSet(client, baselineCommit, targetCommit)
      ).files.has("vendor/demo"),
    ).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "isolates committed changes from checkout, info, and global attributes without running diff commands",
    async () => {
      const repository = await createGitRepository();
      await repository.write("delete.txt", "deleted\n");
      await repository.write("modify.txt", "line one\nline three\n");
      await repository.write("rename-old.txt", "first\nthird\n");
      await repository.write(":(literal)magic.txt", "before\n");
      await writeFile(
        join(repository.root, "binary.bin"),
        Buffer.from([0x62, 0x65, 0x66, 0x6f, 0x72, 0x65, 0x00]),
      );
      await repository.commitAll("baseline shapes");
      const baselineCommit = (await repository.git(["rev-parse", "HEAD"]))
        .stdout;

      await rm(join(repository.root, "delete.txt"));
      await repository.write("modify.txt", "line one\nline two\nline three\n");
      await repository.git(["mv", "rename-old.txt", "rename-new.txt"]);
      await repository.write("rename-new.txt", "first\nsecond\nthird\n");
      await repository.write("-option-looking.txt", "option\n");
      await repository.write(":(literal)magic.txt", "after\n");
      await writeFile(
        join(repository.root, "binary.bin"),
        Buffer.from([0x61, 0x66, 0x74, 0x65, 0x72, 0x00]),
      );
      await repository.commitAll("target shapes");
      const targetCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;
      const client = new GitClient(repository.root);
      const expected = [
        {
          path: "-option-looking.txt",
          status: "added",
          addedRanges: [{ start: 1, end: 1 }],
        },
        {
          path: ":(literal)magic.txt",
          status: "modified",
          addedRanges: [{ start: 1, end: 1 }],
        },
        { path: "binary.bin", status: "modified", addedRanges: [] },
        { path: "delete.txt", status: "deleted", addedRanges: [] },
        {
          path: "modify.txt",
          status: "modified",
          addedRanges: [{ start: 2, end: 2 }],
        },
        {
          path: "rename-new.txt",
          previousPath: "rename-old.txt",
          status: "renamed",
          addedRanges: [{ start: 2, end: 2 }],
        },
      ];
      expect([
        ...(
          await readCommitChangeSet(client, baselineCommit, targetCommit)
        ).files.values(),
      ]).toEqual(expected);

      const sentinel = join(repository.root, "DIFF_COMMAND_EXECUTED");
      const converter = join(repository.root, "textconv.sh");
      await repository.write(
        "textconv.sh",
        `#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\ncat "$1"\n`,
      );
      await chmod(converter, 0o755);
      for (const driver of ["dirty", "info", "global"]) {
        await repository.git(["config", `diff.${driver}.textconv`, converter]);
        await repository.git(["config", `diff.${driver}.command`, converter]);
      }
      await repository.git(["config", "diff.external", converter]);

      await repository.write(
        ".gitattributes",
        ":(literal)magic.txt -diff\nrename-new.txt diff=dirty\n",
      );
      expect([
        ...(
          await readCommitChangeSet(client, baselineCommit, targetCommit)
        ).files.values(),
      ]).toEqual(expected);

      const infoDirectory = join(repository.root, ".git", "info");
      await mkdir(infoDirectory, { recursive: true });
      await writeFile(
        join(infoDirectory, "attributes"),
        "modify.txt -diff\nrename-new.txt diff=info\n",
      );
      expect([
        ...(
          await readCommitChangeSet(client, baselineCommit, targetCommit)
        ).files.values(),
      ]).toEqual(expected);

      const globalRoot = await mkdtemp(join(tmpdir(), "zedbee-global-attrs-"));
      const globalAttributes = join(globalRoot, "attributes");
      const globalConfig = join(globalRoot, "gitconfig");
      await writeFile(
        globalAttributes,
        "-option-looking.txt -diff\ndelete.txt diff=global\n",
      );
      await repository.git([
        "config",
        "--file",
        globalConfig,
        "core.attributesFile",
        globalAttributes,
      ]);
      const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      try {
        expect([
          ...(
            await readCommitChangeSet(client, baselineCommit, targetCommit)
          ).files.values(),
        ]).toEqual(expected);
      } finally {
        if (originalGlobalConfig === undefined) {
          delete process.env.GIT_CONFIG_GLOBAL;
        } else {
          process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
        }
        await rm(globalRoot, { recursive: true, force: true });
      }

      await expect(access(sentinel)).rejects.toThrow();
    },
  );

  it.each([
    ["staged", (git: GitClient) => readStagedChangeSet(git)],
    [
      "commit",
      (git: GitClient) =>
        readCommitChangeSet(git, "baseline-oid", "target-oid"),
    ],
  ])("fails closed when %s diff output is not a patch", async (_kind, read) => {
    const git = {
      async run() {
        return { stdout: "not Git diff output", stderr: "", exitCode: 0 };
      },
    } as unknown as GitClient;

    await expect(read(git)).rejects.toThrow(
      "Git returned invalid diff output.",
    );
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

  it("fails closed when sections share a normalized target path", async () => {
    const git = {
      async run() {
        return {
          stdout:
            "diff --git a/value.ts b/value.ts\nindex 1111111..2222222 100644\n--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-old\n+first\ndiff --git a/renamed.ts b/value.ts\nindex 3333333..4444444 100644\n--- a/renamed.ts\n+++ b/value.ts\n@@ -1 +4 @@\n-old\n+second\n",
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
  it("marks every target line introduced without changing modified or renamed status", () => {
    const files = new Map([
      [
        "value.dat",
        {
          path: "value.dat",
          status: "modified" as const,
          addedRanges: [],
        },
      ],
      [
        "new.dat",
        {
          path: "new.dat",
          previousPath: "old.dat",
          status: "renamed" as const,
          addedRanges: [],
        },
      ],
    ]);
    const metadata: ChangeSet = {
      files,
      isEmpty: false,
      containsAddedLine: () => false,
    };

    const changeSet = addWholeFileLineRanges(
      metadata,
      new Map([
        ["value.dat", 1],
        ["new.dat", 2],
      ]),
    );

    expect([...changeSet.files.values()]).toEqual([
      {
        path: "new.dat",
        previousPath: "old.dat",
        status: "renamed",
        addedRanges: [{ start: 1, end: 2 }],
      },
      {
        path: "value.dat",
        status: "modified",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    expect(changeSet.containsAddedLine("new.dat", 2)).toBe(true);
  });

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

it("preserves Git header prefixes, UTF-8 bytes and quotation in all diff readers", async () => {
  const repo = await createGitRepository();
  const git = new GitClient(repo.root);
  const quoted = process.platform === "win32" ? "café.ts" : 'café"q.ts';
  await repo.write("a/deleted.ts", "old\n");
  await repo.write("b/old.ts", "renamed\n");
  await repo.write("a/stays.ts", "before\n");
  await repo.commitAll("initial");
  const base = (await repo.git(["rev-parse", "HEAD"])).stdout;
  await repo.git(["mv", "b/old.ts", "a/" + quoted]);
  await repo.git(["rm", "a/deleted.ts"]);
  await repo.write("a/stays.ts", "after\n");
  await repo.write("b/" + quoted, "new\n");
  await repo.git(["add", "--all"]);
  const staged = await readStagedChangeSet(git);
  const entries = [...staged.files];
  expect([...staged.files.keys()].sort()).toEqual(
    ["a/deleted.ts", "a/" + quoted, "a/stays.ts", "b/" + quoted].sort(),
  );
  expect(staged.files.get("a/" + quoted)?.previousPath).toBe("b/old.ts");
  expect([
    ...(
      await addStagedLineRanges(
        git,
        await discoverStagedChangeSet(git),
        new Set(),
      )
    ).files,
  ]).toEqual(entries);
  await repo.commitAll("selected");
  const target = (await repo.git(["rev-parse", "HEAD"])).stdout;
  expect([...(await readCommitChangeSet(git, base, target)).files]).toEqual(
    entries,
  );
  expect([
    ...(
      await addCommitLineRanges(
        git,
        await discoverCommitChangeSet(git, base, target),
        new Set(),
        base,
        target,
      )
    ).files,
  ]).toEqual(entries);
});

it.skipIf(process.platform === "win32")(
  "normalizes Git type changes in staged and committed patches",
  async () => {
    const repo = await createGitRepository();
    await symlink("other.js", join(repo.root, "value.js"));
    await repo.commitAll("link");
    const base = (await repo.git(["rev-parse", "HEAD"])).stdout;
    await rm(join(repo.root, "value.js"));
    await repo.write("value.js", "first\nsecond\n");
    await repo.git(["add", "value.js"]);
    const git = new GitClient(repo.root);
    const expected = {
      path: "value.js",
      status: "modified",
      addedRanges: [{ start: 1, end: 2 }],
    };
    expect((await readStagedChangeSet(git)).files.get("value.js")).toEqual(
      expected,
    );
    expect(
      (
        await addStagedLineRanges(
          git,
          await discoverStagedChangeSet(git),
          new Set(),
        )
      ).files.get("value.js"),
    ).toEqual(expected);
    await repo.commitAll("regular file");
    const target = (await repo.git(["rev-parse", "HEAD"])).stdout;
    expect(
      (await readCommitChangeSet(git, base, target)).files.get("value.js"),
    ).toEqual(expected);
    await rm(join(repo.root, "value.js"));
    await symlink("other.js", join(repo.root, "value.js"));
    await repo.git(["add", "value.js"]);
    expect((await readStagedChangeSet(git)).files.get("value.js")?.status).toBe(
      "modified",
    );
  },
);

it("collects multiple bounded batches without losing rename ranges or excluded paths", async () => {
  const repo = await createGitRepository();
  await repo.write("old space.js", "one\ntwo\nthree\nfour\n");
  await repo.commitAll("base");
  const base = (await repo.git(["rev-parse", "HEAD"])).stdout;
  await repo.git(["mv", "old space.js", "新 name.js"]);
  await repo.write("新 name.js", "one\ntwo\nadded\nthree\nfour\n");
  await repo.write("another.js", "added\n");
  await repo.write("excluded.js", "ignored\n");
  await repo.git(["add", "--all"]);
  const git = new GitClient(repo.root);
  const excluded = new Set(["excluded.js"]);
  const metadata = await discoverStagedChangeSet(git);
  const batches = await addStagedLineRanges(
    git,
    metadata,
    excluded,
    undefined,
    30,
  );
  expect([...batches.files]).toEqual([
    ...(await addStagedLineRanges(git, metadata, excluded)).files,
  ]);
  expect(batches.files.get("新 name.js")?.addedRanges).toEqual([
    { start: 3, end: 3 },
  ]);
  expect(batches.files.get("excluded.js")?.addedRanges).toEqual([]);
  await repo.commitAll("target");
  const target = (await repo.git(["rev-parse", "HEAD"])).stdout;
  expect([
    ...(
      await addCommitLineRanges(
        git,
        await discoverCommitChangeSet(git, base, target),
        excluded,
        base,
        target,
        undefined,
        30,
      )
    ).files,
  ]).toEqual([...batches.files]);
});
