import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitClient } from "../../src/git/client.js";
import { buildCommitSnapshotPair } from "../../src/git/snapshot.js";
import { createGitRepository } from "../helpers/git-repository.js";

const writes = vi.hoisted(() => ({
  before: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...parameters: Parameters<typeof actual.open>) {
      const handle = await actual.open(...parameters);
      if (!String(parameters[0]).includes("zedbee-snapshot-")) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "write")
            return async (...args: Parameters<typeof handle.write>) => {
              await writes.before?.();
              return handle.write(...args);
            };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
afterEach(() => {
  writes.before = undefined;
});

describe("snapshot side overlap", () => {
  it("admits another small blob while earlier file writes are still active", async () => {
    const repo = await createGitRepository();
    for (let i = 0; i < 8; i++)
      await repo.write(`file-${i}.ts`, `export const value = ${i};\n`);
    await repo.commitAll("files");
    const oid = (await repo.git(["rev-parse", "HEAD"])).stdout;
    let release!: () => void;
    let first!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      first = resolve;
    });
    let active = 0;
    let peak = 0;
    writes.before = async () => {
      active++;
      peak = Math.max(peak, active);
      first();
      await held;
      active--;
    };
    const git = new GitClient(repo.root);
    let visited = 0;
    git.streamBlobs = async (ids, visit) => {
      for (const objectId of ids) {
        visited++;
        const bytes = Buffer.from("export const value = 1;\n");
        await visit({
          objectId,
          size: bytes.length,
          chunks: (async function* () {
            yield bytes;
          })(),
        });
      }
    };
    const pending = buildCommitSnapshotPair(repo.root, git, oid, oid);
    await began;
    // After each side's first visitor, serial writes cannot reach visitor 3.
    // Release in finally so a failed assertion never strands a real Git child.
    try {
      expect(visited).toBeGreaterThan(2);
    } finally {
      release();
      const pair = await pending;
      await pair.cleanup();
    }
    expect(peak).toBeLessThanOrEqual(4);
  });
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
