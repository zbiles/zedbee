import {
  readFile,
  access,
  chmod,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GitClient } from "../../src/git/client.js";
import { captureSelectedIndexComparison } from "../../src/git/selected-comparison.js";
import { readStagedChangeSet } from "../../src/git/change-set.js";
import { createGitRepository } from "../helpers/git-repository.js";

const faults = vi.hoisted(() => ({
  removeBeforeRead: "",
  beforeRead: undefined as (() => Promise<void>) | undefined,
  failCleanup: false,
  failedRoots: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async readFile(...parameters: Parameters<typeof actual.readFile>) {
      let canonical = String(parameters[0]);
      if (faults.removeBeforeRead !== "") {
        try {
          canonical = await actual.realpath(canonical);
        } catch {
          /* An unrelated optional path may not exist. */
        }
      }
      if (canonical === faults.removeBeforeRead) {
        faults.removeBeforeRead = "";
        if (faults.beforeRead) await faults.beforeRead();
        else await actual.rm(String(parameters[0]));
      }
      return actual.readFile(...parameters);
    },
    async rm(...parameters: Parameters<typeof actual.rm>) {
      if (
        faults.failCleanup &&
        String(parameters[0]).includes("zedbee-selection-")
      ) {
        faults.failedRoots.push(String(parameters[0]));
        throw new Error("private cleanup failed");
      }
      return actual.rm(...parameters);
    },
  };
});
afterEach(async () => {
  faults.removeBeforeRead = "";
  faults.beforeRead = undefined;
  faults.failCleanup = false;
  for (const root of faults.failedRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("captured index comparison", () => {
  it("overlaps independent baseline and index-path metadata reads", async () => {
    const repo = await createGitRepository();
    await repo.write("value.ts", "export const value = 1;\n");
    await repo.commitAll("baseline");
    const git = new GitClient(repo.root);
    const run = git.run.bind(git);
    let start!: () => void;
    let release!: () => void;
    let started = 0;
    const began = new Promise<void>((resolve) => {
      start = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    git.run = async (args, options) => {
      if (args[0] === "rev-parse" && started < 3) {
        started++;
        start();
        await held;
      }
      return run(args, options);
    };
    const pending = captureSelectedIndexComparison(git);
    try {
      await began;
      expect(started).toBe(3);
    } finally {
      release();
      const selected = await pending;
      await selected.cleanup();
    }
  });
  it("captures the selected bytes on Git versions without rev-parse path-format support", async () => {
    const repo = await createGitRepository();
    await repo.write("value.ts", "export const value = 1;\n");
    await repo.commitAll("baseline");
    await repo.write("value.ts", "export const value = 2;\n");
    await repo.git(["add", "value.ts"]);
    const git = new GitClient(repo.root);
    const run = git.run.bind(git);
    git.run = async (args, options) =>
      args.includes("--path-format=absolute")
        ? {
            ...(await run(["rev-parse", "--git-path", "index"], options)),
            stdout: "--path-format=absolute\n.git/index",
          }
        : run(args, options);
    const selected = await captureSelectedIndexComparison(git);
    onTestFinished(selected.cleanup);
    expect(
      (await selected.bind(new GitClient(repo.root)).run(["show", ":value.ts"]))
        .stdout,
    ).toBe("export const value = 2;");
  });
  it("rejects an index changed and restored between its initial stat and byte read", async () => {
    const repo = await createGitRepository();
    await repo.write("value.ts", "export const value = 1;\n");
    await repo.commitAll("baseline");
    const index = await realpath(join(repo.root, ".git/index"));
    const bytes = await readFile(index);
    faults.removeBeforeRead = index;
    faults.beforeRead = async () => {
      await writeFile(index, "changed");
      await writeFile(index, bytes);
    };
    await expect(
      captureSelectedIndexComparison(new GitClient(repo.root)),
    ).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
  });

  it.each(["missing", "corrupt"])(
    "fails closed for a %s split-index dependency without modifying the selected index",
    async (kind) => {
      const repo = await createGitRepository();
      await repo.write("value.ts", "export const value = 1;\n");
      await repo.commitAll("baseline");
      await repo.git(["update-index", "--split-index"]);
      const index = join(repo.root, ".git/index");
      const before = await readFile(index);
      const shared = resolve(
        repo.root,
        (await repo.git(["rev-parse", "--shared-index-path"])).stdout,
      );
      if (kind === "missing") await rm(shared);
      else await writeFile(shared, "corrupt");
      await expect(
        captureSelectedIndexComparison(new GitClient(repo.root)),
      ).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
      expect(await readFile(index)).toEqual(before);
    },
  );

  it.each(["split", "initial"])(
    "does not execute repository hooks or fsmonitor while capturing %s indexes",
    async (kind) => {
      const repo = await createGitRepository();
      if (kind === "split") {
        await repo.write("value.ts", "export const value = 1;\n");
        await repo.commitAll("baseline");
        await repo.git(["update-index", "--split-index"]);
      }
      const hook = join(repo.root, ".git/hooks/post-index-change");
      const fsmonitor = join(repo.root, ".git/hooks/test-fsmonitor");
      await writeFile(hook, '#!/bin/sh\nprintf ran > "$PWD/hook-ran"\n');
      await chmod(hook, 0o755);
      await writeFile(
        fsmonitor,
        '#!/bin/sh\nprintf ran > "$PWD/fsmonitor-ran"\nprintf "token\\0"\n',
      );
      await chmod(fsmonitor, 0o755);
      await repo.git(["config", "core.fsmonitor", fsmonitor]);
      const selected = await captureSelectedIndexComparison(
        new GitClient(repo.root),
      );
      onTestFinished(() => selected.cleanup());
      await selected
        .bind(new GitClient(repo.root))
        .run(["ls-files", "--stage"]);
      await expect(access(join(repo.root, "hook-ran"))).rejects.toThrow();
      await expect(access(join(repo.root, "fsmonitor-ran"))).rejects.toThrow();
    },
  );

  it("rejects an index disappearing after its initial metadata was read", async () => {
    const repo = await createGitRepository();
    await repo.write("value.ts", "export const value = 1;\n");
    await repo.commitAll("baseline");
    faults.removeBeforeRead = await realpath(join(repo.root, ".git/index"));
    const result = captureSelectedIndexComparison(new GitClient(repo.root));
    void result.then(
      (selected) => selected.cleanup(),
      () => {},
    );
    await expect(result).rejects.toThrow();
  });

  it("retains a capture failure alongside a private-index cleanup failure", async () => {
    const repo = await createGitRepository();
    await writeFile(join(repo.root, ".git/index"), "invalid index");
    faults.failCleanup = true;
    await expect(
      captureSelectedIndexComparison(new GitClient(repo.root)),
    ).rejects.toMatchObject({ originalError: { code: "GIT_COMMAND_FAILED" } });
  });

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
