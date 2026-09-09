import { Worker } from "node:worker_threads";
import { exactFields } from "../checks/runner/envelope.js";
import { HEX, ServiceUnavailableError } from "./protocol.js";

/** Own every file worker through both phases and its final exit. */
export async function hashFilesInWorkers(
  files: readonly string[],
  budget: SharedArrayBuffer,
): Promise<string[]> {
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(
    source ? "./identity-worker.ts" : "./identity-worker.js",
    import.meta.url,
  );
  const batches = Array.from(
    { length: Math.min(4, files.length) },
    () => [] as string[],
  );
  files.forEach((file, index) => batches[index % batches.length]!.push(file));
  const owners: Array<{
    worker: Worker;
    hashed: Promise<string[]>;
    exited: Promise<void>;
    validate: () => void;
  }> = [];
  let unavailable!: () => void;
  const failure = new Promise<never>((_resolve, reject) => {
    unavailable = () => reject(new ServiceUnavailableError());
  });
  // A worker can fail during creation of its siblings, before the first race.
  void failure.catch(() => {});
  try {
    for (const batch of batches) {
      const worker = new Worker(entry, {
        execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
        workerData: { files: batch, budget },
      });
      let phase: "hashing" | "hashed" | "validating" | "validated" = "hashing";
      let receive!: (hashes: string[]) => void;
      const hashed = new Promise<string[]>((resolve) => {
        receive = resolve;
      });
      const exited = new Promise<void>((resolve) => {
        worker.once("exit", (code) => {
          if (code !== 0 || phase !== "validated") unavailable();
          resolve();
        });
      });
      owners.push({
        worker,
        hashed,
        exited,
        validate: () => {
          phase = "validating";
          worker.postMessage({ type: "validate" });
        },
      });
      worker.once("error", unavailable);
      worker.on("message", (value: unknown) => {
        if (
          phase === "hashing" &&
          exactFields(value, ["type", "hashes"]) &&
          value.type === "hashed" &&
          Array.isArray(value.hashes) &&
          value.hashes.length === batch.length &&
          value.hashes.every(
            (hash: unknown) => typeof hash === "string" && HEX.test(hash),
          )
        ) {
          phase = "hashed";
          receive(value.hashes);
        } else if (
          phase === "validating" &&
          exactFields(value, ["type"]) &&
          value.type === "validated"
        ) {
          phase = "validated";
        } else unavailable();
      });
    }
    const hashes = await Promise.race([
      Promise.all(owners.map((owner) => owner.hashed)),
      failure,
    ]);
    // No worker may validate its earlier files until every batch has finished.
    for (const owner of owners) owner.validate();
    await Promise.race([
      Promise.all(owners.map((owner) => owner.exited)),
      failure,
    ]);
    return files.map(
      (_file, index) =>
        hashes[index % batches.length]![Math.floor(index / batches.length)]!,
    );
  } finally {
    // On errors this stops every sibling; success is already naturally exited.
    // Settlement must include cleanup, never leave hashing in the background.
    await Promise.all(owners.map((owner) => owner.worker.terminate()));
  }
}
