import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitClient } from "../../src/git/client.js";
import { buildCommitSnapshotPair } from "../../src/git/snapshot.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("snapshot side overlap", () => {
  it("starts both Git blob streams before either completes", async () => {
    const repo = await createGitRepository();
    await repo.write("nested/file.ts", "export const value = 1;\n");
    await repo.commitAll("baseline");
    const oid = (await repo.git(["rev-parse", "HEAD"])).stdout;
    const git = new GitClient(repo.root);
    const original = git.streamBlobs.bind(git);
    let started = 0;
    let begin!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    git.streamBlobs = async (...parameters) => {
      started++;
      begin();
      await held;
      return original(...parameters);
    };
    const pending = buildCommitSnapshotPair(repo.root, git, oid, oid);
    try {
      await began;
      expect(started).toBe(2);
    } finally {
      release();
      const pair = await pending;
      try {
        expect(
          await readFile(join(pair.baselineDir, "nested/file.ts"), "utf8"),
        ).toBe("export const value = 1;\n");
        expect(
          await readFile(join(pair.targetDir, "nested/file.ts"), "utf8"),
        ).toBe("export const value = 1;\n");
      } finally {
        await pair.cleanup();
      }
    }
  });
});
