import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";

const workers = vi.hoisted(() => [] as Worker[]);
vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        workers.push(this);
      }
    },
  };
});
import { installedContentIdentity } from "../../src/service/identity.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

it.each([false, true])(
  "owns metadata work through worker exit (rejected: %s)",
  async (reject) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "zedbee-identity-worker-")),
    );
    roots.push(root);
    await mkdir(join(root, "dist"));
    await writeFile(
      join(root, "package.json"),
      reject ? "invalid" : '{"name":"fixture"}',
    );
    const pending = installedContentIdentity(root, "dist");
    if (reject) await expect(pending).rejects.toThrow();
    else await expect(pending).resolves.toMatch(/^[a-f0-9]{64}$/);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.threadId).toBe(-1);
  },
);
