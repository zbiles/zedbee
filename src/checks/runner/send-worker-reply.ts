import type { Serializable } from "node:child_process";

/** Flush a provisional reply; readiness is a separate matching acknowledgement. */
export function sendWorkerReply(reply: Serializable): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error("Owner disconnected"));
      return;
    }
    process.send(reply, (error) => (error ? reject(error) : resolve()));
  });
}
