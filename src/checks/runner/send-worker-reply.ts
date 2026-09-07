import type { Serializable } from "node:child_process";

/** A reply is provisional until the owner observes this worker's own exit. */
export function sendWorkerReply(reply: Serializable): void {
  if (!process.connected || !process.send) process.exit(1);
  process.send(reply, (error) => process.exit(error ? 1 : 0));
}
