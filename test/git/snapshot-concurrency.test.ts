import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitClient } from "../../src/git/client.js";
import { GitCommandError } from "../../src/git/errors.js";
import { buildCommitSnapshotPair } from "../../src/git/snapshot.js";
import { createGitRepository } from "../helpers/git-repository.js";

const writes = vi.hoisted(() => ({
  before: undefined as (() => Promise<void>) | undefined,
  root: "",
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...parameters: Parameters<typeof actual.open>) {
      const handle = await actual.open(...parameters);
      if (!String(parameters[0]).includes("zedbee-snapshot-")) return handle;
      writes.root = dirname(dirname(String(parameters[0])));
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
  it("waits for the aborted peer's write and Git reader before cleaning a destination failure", async () => {
    const repo = await createGitRepository();
    await repo.write("file.ts", "export const value = 1;\n");
    await repo.commitAll("baseline");
    const oid = (await repo.git(["rev-parse", "HEAD"])).stdout;
    function barrier() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }
    const ready = barrier();
    const fail = barrier();
    const aborted = barrier();
    const readerClose = barrier();
    const peerWriteComplete = barrier();
    const siblingWrite = barrier();
    const bothWriting = barrier();
    let readers = 0;
    let writing = 0;
    let returned = false;
    const original = new Error("destination failure");
    writes.before = async () => {
      const first = writing++ === 0;
      if (writing === 2) bothWriting.release();
      if (first) {
        await fail.promise;
        throw original;
      }
      await siblingWrite.promise;
    };
    const git = new GitClient(repo.root);
    git.streamBlobs = async (ids, visit, options = {}) => {
      const signal = options.signal!;
      const onAbort = () => aborted.release();
      signal.addEventListener("abort", onAbort, { once: true });
      if (++readers === 2) ready.release();
      try {
        const bytes = Buffer.from("export const value = 1;\n");
        await visit({
          objectId: ids[0]!,
          size: bytes.length,
          chunks: (async function* () {
            yield bytes;
          })(),
        });
        peerWriteComplete.release();
        await readerClose.promise;
        throw new GitCommandError("GIT_ABORTED", "Git command was aborted.");
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const observed = buildCommitSnapshotPair(repo.root, git, oid, oid).then(
      () => {
        returned = true;
        return undefined;
      },
      (error: unknown) => {
        returned = true;
        return error;
      },
    );
    try {
      await ready.promise;
      await bothWriting.promise;
      fail.release();
      await aborted.promise;
      expect(returned).toBe(false);
      await access(writes.root);
      siblingWrite.release();
      await peerWriteComplete.promise;
      expect(returned).toBe(false);
      await access(writes.root);
    } finally {
      fail.release();
      readerClose.release();
      siblingWrite.release();
    }
    expect(await observed).toBe(original);
    await expect(access(writes.root)).rejects.toThrow();
  });
  it("keeps each blob visitor backpressured and limits active writes to two", async () => {
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
      expect(visited).toBe(2);
    } finally {
      release();
      const pair = await pending;
      await pair.cleanup();
    }
    expect(peak).toBeLessThanOrEqual(2);
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
