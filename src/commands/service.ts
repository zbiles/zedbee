import { serviceStatus, stopService } from "../service/client.js";

/** Management does not acquire an executor or start analysis. */
export async function executeServiceCommand(
  operation: "status" | "stop",
  format: "text" | "json",
  io: { writeStdout(value: string): void; writeStderr(value: string): void },
): Promise<0 | 2> {
  try {
    const status = await (operation === "status"
      ? serviceStatus()
      : stopService());
    io.writeStdout(
      format === "json"
        ? `${JSON.stringify(status)}\n`
        : status.state === "running"
          ? `Zedbee analyzer service is running (${status.activeSessions} active sessions, ${status.concurrency} workers).\n`
          : `Zedbee analyzer service is ${status.state}.\n`,
    );
    return status.state === "unavailable" ? 2 : 0;
  } catch {
    io.writeStderr("Zedbee could not prove analyzer service cleanup.\n");
    return 2;
  }
}
