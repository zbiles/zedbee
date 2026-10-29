import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it, onTestFinished } from "vitest";
import { GitClient } from "../../src/git/client.js";
import { captureSelectedIndexComparison } from "../../src/git/selected-comparison.js";
import { readStagedChangeSet } from "../../src/git/change-set.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("captured index comparison", () => {
  it.each([false, true])(
    "keeps original bytes, flags and line ranges after live HEAD/index replacement (split=%s)",
    async (split) => {
      const repo = await createGitRepository();
      await repo.write(
        "value.ts",
        "export const first = 1;\nexport const second = 2;\n",
      );
      await repo.commitAll("baseline");
      await repo.write(
        "value.ts",
        "export const first = 3;\nexport const second = 2;\n",
      );
      await repo.git(["add", "value.ts"]);
      await repo.write("intent.ts", "export const intent = 1;\n");
      await repo.git(["add", "-N", "intent.ts"]);
      if (split) await repo.git(["update-index", "--split-index"]);
      const original = await readFile(join(repo.root, ".git", "index"));
      const selected = await captureSelectedIndexComparison(
        new GitClient(repo.root),
      );
      onTestFinished(() => selected.cleanup());
      expect(await readFile(join(repo.root, ".git", "index"))).toEqual(
        original,
      );
      const client = selected.bind(new GitClient(repo.root));
      const before = await readStagedChangeSet(client);
      await repo.git(["reset", "--", "intent.ts"]);
      await repo.commitAll("move HEAD and clear staged diff");
      await repo.write(
        "value.ts",
        "export const first = 3;\nexport const second = 4;\n",
      );
      await repo.git(["add", "value.ts"]);
      const after = await readStagedChangeSet(client);
      expect([...after.files.values()]).toEqual([...before.files.values()]);
      expect(after.files.get("value.ts")?.addedRanges).toEqual([
        { start: 1, end: 1 },
      ]);
      expect(after.files.has("intent.ts")).toBe(false);
      expect((await client.run(["show", ":value.ts"])).stdout).toContain(
        "second = 2",
      );
      const index = (await client.run(["rev-parse", "--git-path", "index"]))
        .stdout;
      await selected.cleanup();
      await expect(access(index)).rejects.toThrow();
    },
  );

  it("uses a relative alternate index without changing the ordinary index or global environment", async () => {
    const repo = await createGitRepository();
    await repo.write("value.ts", "export const value = 1;\n");
    await repo.commitAll("baseline");
    const ordinary = await readFile(join(repo.root, ".git", "index"));
    const alternate = "selected.index";
    await execa("git", ["read-tree", "HEAD"], {
      cwd: repo.root,
      env: { GIT_INDEX_FILE: alternate },
    });
    await repo.write("value.ts", "export const value = 2;\n");
    await execa("git", ["add", "value.ts"], {
      cwd: repo.root,
      env: { GIT_INDEX_FILE: alternate },
    });
    const client = new GitClient(repo.root, {
      environment: { GIT_INDEX_FILE: alternate },
    });
    const selected = await captureSelectedIndexComparison(client);
    onTestFinished(() => selected.cleanup());
    const changes = await readStagedChangeSet(selected.bind(client));
    expect([...changes.files.keys()]).toEqual(["value.ts"]);
    expect(await readFile(join(repo.root, ".git", "index"))).toEqual(ordinary);
    expect(process.env.GIT_INDEX_FILE).toBeUndefined();
  });

  it("captures an initial commit with no index and cleans independently", async () => {
    const repo = await createGitRepository();
    const first = await captureSelectedIndexComparison(
      new GitClient(repo.root),
    );
    const second = await captureSelectedIndexComparison(
      new GitClient(repo.root),
    );
    onTestFinished(() => first.cleanup());
    onTestFinished(() => second.cleanup());
    expect(first.baselineCommit).toBeNull();
    expect(
      (await readStagedChangeSet(first.bind(new GitClient(repo.root)))).isEmpty,
    ).toBe(true);
    await first.cleanup();
    expect(
      (await readStagedChangeSet(second.bind(new GitClient(repo.root))))
        .isEmpty,
    ).toBe(true);
  });
});
