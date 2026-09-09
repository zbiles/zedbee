import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";

const roots: string[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zedbee-hash-phase-"));
  roots.push(root);
  const files = [join(root, "one"), join(root, "two")];
  await writeFile(files[0]!, "ab");
  await writeFile(files[1]!, "cd");
  return files;
}
function start(files: string[], budget = new SharedArrayBuffer(8)) {
  const worker = new Worker(
    new URL("../../src/service/identity-worker.ts", import.meta.url),
    {
      execArgv: ["--import", import.meta.resolve("tsx")],
      workerData: { files, budget },
    },
  );
  workers.push(worker);
  const messages: unknown[] = [];
  let failure: unknown;
  worker.on("message", (value) => messages.push(value));
  worker.on("error", (error) => {
    failure = error;
  });
  const exit = new Promise<number>((resolve) => worker.once("exit", resolve));
  const hashed = new Promise<unknown>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", () =>
      reject(failure ?? new Error("Exited before hashing")),
    );
  });
  return { worker, messages, exit, hashed };
}

it("retains observations until requested validation and exits after the final reply", async () => {
  const run = start(await fixture());
  await expect(run.hashed).resolves.toEqual({
    type: "hashed",
    hashes: [
      createHash("sha256").update("ab").digest("hex"),
      createHash("sha256").update("cd").digest("hex"),
    ],
  });
  expect(run.worker.threadId).not.toBe(-1);
  run.worker.postMessage({ type: "validate" });
  expect(await run.exit).toBe(0);
  expect(run.messages.at(-1)).toEqual({ type: "validated" });
  expect(run.worker.threadId).toBe(-1);
});

it("rejects a same-size edit after hashing but before the global validation phase", async () => {
  const files = await fixture();
  const run = start(files);
  await expect(run.hashed).resolves.toMatchObject({ type: "hashed" });
  const before = await stat(files[0]!);
  await writeFile(files[0]!, "ba");
  await utimes(files[0]!, before.atime, before.mtime);
  run.worker.postMessage({ type: "validate" });
  expect(await run.exit).toBe(1);
  expect(run.messages).toHaveLength(1);
});

it("shares the remaining byte budget across hash workers before reading their files", async () => {
  const files = await fixture();
  const budget = new SharedArrayBuffer(8);
  const counter = new BigInt64Array(budget);
  Atomics.store(counter, 0, 2n * 1024n ** 3n - 3n);
  const runs = files.map((file) => start([file], budget));
  const results = await Promise.allSettled(runs.map((run) => run.hashed));
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(Atomics.load(counter, 0)).toBe(2n * 1024n ** 3n - 1n);
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled")
      runs[index]!.worker.postMessage({ type: "validate" });
  }
  expect((await Promise.all(runs.map((run) => run.exit))).sort()).toEqual([
    0, 1,
  ]);
});
