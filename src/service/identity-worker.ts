import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { installedContentIdentitySync } from "./identity-content.js";

// Fixed installed metadata entry; installation paths are data, never code.
if (isMainThread || !parentPort) throw new Error("Metadata worker required");
parentPort.postMessage(
  installedContentIdentitySync(workerData.root, workerData.tree),
);
parentPort.close();
