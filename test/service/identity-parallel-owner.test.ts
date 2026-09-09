import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Worker } from "node:worker_threads";

const controls = vi.hoisted(() => ({
  workers: [] as Worker[],
  beforeValidation: undefined as (() => void) | undefined,
  loseWorker: false,
  hashed: new Set<Worker>(),
  validationCounts: [] as number[],
}));
vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        controls.workers.push(this);
        this.on("message", (value) => {
          if (value?.type === "hashed") controls.hashed.add(this);
        });
        if (controls.loseWorker && controls.workers.length === 1)
          this.once("message", () => {
            void this.terminate();
          });
      }
      override postMessage(...args: Parameters<Worker["postMessage"]>) {
        controls.validationCounts.push(controls.hashed.size);
        const mutate = controls.beforeValidation;
        controls.beforeValidation = undefined;
        mutate?.();
        super.postMessage(...args);
      }
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    controls.workers.splice(0).map((worker) => worker.terminate()),
  );
  controls.loseWorker = false;
  controls.hashed.clear();
  controls.validationCounts.length = 0;
  controls.beforeValidation = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zedbee-hash-owner-"));
  roots.push(root);
  const files = Array.from({ length: 8 }, (_, index) =>
    join(root, String(index)),
  );
  await Promise.all(
    files.map((file, index) => writeFile(file, `original${index}`)),
  );
  return files;
}

it.each(["success", "late-mutation", "worker-loss"])(
  "settles only after all parallel file workers exit: %s",
  async (scenario) => {
    const files = await fixture();
    if (scenario === "late-mutation")
      controls.beforeValidation = () => writeFileSync(files[0]!, "modified0");
    controls.loseWorker = scenario === "worker-loss";
    const { hashFilesInWorkers } =
      await import("../../src/service/identity-parallel.js");
    const result = hashFilesInWorkers(files, new SharedArrayBuffer(8));
    if (scenario === "success")
      await expect(result).resolves.toEqual(
        files.map((_file, index) =>
          createHash("sha256").update(`original${index}`).digest("hex"),
        ),
      );
    else await expect(result).rejects.toThrow();
    expect(controls.workers).toHaveLength(4);
    expect(controls.validationCounts.every((count) => count === 4)).toBe(true);
    expect(controls.workers.every((worker) => worker.threadId === -1)).toBe(
      true,
    );
  },
);
