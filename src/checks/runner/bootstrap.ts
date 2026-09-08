import { pathToFileURL } from "node:url";
import { sendWorkerReply } from "./send-worker-reply.js";

// No engine, registry, or injected worker module is evaluated until the owner
// has assigned this PID to its Job Object. An owner lost before assignment
// cannot leave an idle bootstrap alive, including loss before JS startup.
let started = false;
process.on("disconnect", () => process.exit(0));
if (!process.connected) process.exit(0);
process.on("message", async (message: unknown) => {
  const input = message as {
    type?: string;
    workerEntry?: string;
    request?: unknown;
  };
  if (
    started ||
    input.type !== "owned-start" ||
    typeof input.workerEntry !== "string"
  )
    return;
  started = true;
  try {
    await import(pathToFileURL(input.workerEntry).href);
    process.emit("message", input.request, undefined);
  } catch {
    await sendWorkerReply({
      version: 1,
      ok: false,
      category: "startup",
    }).finally(() => process.exit(1));
  }
});
process.send?.({ type: "ready-for-ownership" });
