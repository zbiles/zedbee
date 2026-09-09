import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  installedContentIdentityInWorker,
  hashIdentityFiles,
  validateIdentityObservations,
} from "./identity-content.js";
import { exactFields } from "../checks/runner/envelope.js";
import { ServiceUnavailableError } from "./protocol.js";

// Fixed installed metadata entry; installation paths are data, never code.
if (isMainThread || !parentPort) throw new Error("Metadata worker required");
if (
  exactFields(workerData, ["root", "tree"]) &&
  typeof workerData.root === "string" &&
  typeof workerData.tree === "string"
) {
  parentPort.postMessage(
    await installedContentIdentityInWorker(workerData.root, workerData.tree),
  );
  parentPort.close();
} else if (
  exactFields(workerData, ["files", "budget"]) &&
  Array.isArray(workerData.files) &&
  workerData.files.length <= 100000 &&
  workerData.files.every((file: unknown) => typeof file === "string") &&
  workerData.budget instanceof SharedArrayBuffer &&
  workerData.budget.byteLength === 8
) {
  const { hashes, observed } = hashIdentityFiles(
    workerData.files,
    new BigInt64Array(workerData.budget),
  );
  parentPort.postMessage({ type: "hashed", hashes });
  parentPort.once("message", (value: unknown) => {
    if (!exactFields(value, ["type"]) || value.type !== "validate")
      throw new ServiceUnavailableError();
    validateIdentityObservations(observed);
    parentPort!.postMessage({ type: "validated" });
    parentPort!.close();
  });
} else throw new ServiceUnavailableError();
