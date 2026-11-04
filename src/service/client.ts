import { exactFields } from "../checks/runner/envelope.js";
import type { AnalyzerExecutor } from "../checks/runner/executor.js";
import { ServiceUnavailableError } from "./protocol.js";
import { ServiceState, type StateLease } from "./state.js";
import {
  serviceIdentity,
  serviceLocation,
  type ServiceIdentity,
} from "./identity.js";
import type { ServiceStatus } from "./server.js";
import { ServiceClient, connectService } from "./client-connection.js";
import { executorForConnection } from "./client-executor.js";
import { startCandidate } from "./client-startup.js";

export { ServiceClient, connectService } from "./client-connection.js";
export { executorForConnection } from "./client-executor.js";

export interface ServiceOptions {
  readonly concurrency?: 1 | 2 | 4;
  /** Internal embedding/test isolation; never taken from repository configuration. */
  readonly directory?: string;
}
function validateOptions(options: ServiceOptions): void {
  const concurrency = options.concurrency;
  if (
    !exactFields(options, ["directory", "concurrency"]) ||
    ![1, 2, 4].includes(concurrency ?? 2) ||
    (options.directory !== undefined && typeof options.directory !== "string")
  )
    throw new ServiceUnavailableError();
}
function decodeStatus(value: unknown): ServiceStatus {
  if (
    !exactFields(value, ["state", "pid", "activeSessions", "concurrency"]) ||
    value.state !== "running" ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    !Number.isSafeInteger(value.activeSessions) ||
    (value.activeSessions as number) < 0 ||
    (value.activeSessions as number) > 32 ||
    ![1, 2, 4].includes(value.concurrency as number)
  )
    throw new ServiceUnavailableError();
  return value as unknown as ServiceStatus;
}
export async function acquireServiceExecutor(
  options: ServiceOptions = {},
): Promise<AnalyzerExecutor> {
  validateOptions(options);
  const location = await serviceLocation(options.directory),
    state = new ServiceState(location.directory);
  await state.prepare();
  const record = await state.read();
  const pendingIdentity = serviceIdentity(options.directory);
  // Discovery absence allows independent source-free hashes to overlap. Existing
  // discovery still requires the caller's complete identity before connecting.
  const candidate = record
    ? undefined
    : startCandidate(location, pendingIdentity, options.concurrency ?? 2);
  void candidate?.catch(() => {});
  let identity: ServiceIdentity;
  try {
    identity = await pendingIdentity;
  } catch (error) {
    await candidate?.catch(() => {});
    throw error;
  }
  // Busy means ownership is still held, not that a usable service started.
  let attempted = (await candidate) === "ready";
  const connectCurrent = async (): Promise<ServiceClient | undefined> => {
    const record = await state.read();
    if (!record) return undefined;
    let connected: ServiceClient;
    try {
      connected = await connectService(state, record);
    } catch {
      return undefined;
    }
    if (record.identity === identity.content) return connected;
    // An early candidate may have reported busy while this stale owner was
    // publishing discovery. Retiring it permits one fresh startup attempt.
    attempted = false;
    // Authenticate the exact stale record. Rereading through stopService could
    // target a replacement published by another upgrader in the meantime.
    try {
      let result: unknown;
      try {
        result = await connected.request("drain");
      } catch {
        // A competing drain may close this connection before its reply. A live
        // service that still answers status instead needs explicit recovery;
        // legacy stop would cancel a session admitted after a status check.
        let running = false;
        try {
          decodeStatus(await connected.request("status"));
          running = true;
        } catch {}
        if (running) {
          const error = new ServiceUnavailableError();
          error.message =
            "The previous analyzer service could not drain safely. After active scans finish, run `zedbee service stop` and retry.";
          throw error;
        }
        return undefined;
      }
      if (!exactFields(result, ["state"]) || result.state !== "stopped")
        throw new ServiceUnavailableError();
      return undefined;
    } finally {
      // The provisional reply/socket loss is not cleanup proof. This awaits
      // the handed-off lease, released after endpoint and owner-lock cleanup.
      await connected.close();
    }
  };
  let client = await connectCurrent();
  if (!client) {
    const start = performance.now();
    while (!client && performance.now() - start < 30000) {
      // A competing upgrader can lose its drain socket while the old owner is
      // still cleaning up. Wait for ownership availability or matching discovery
      // before starting; a premature busy candidate cannot replace that owner.
      if (!attempted) {
        const release = await state.lock();
        if (release) {
          await release();
          attempted =
            (await startCandidate(
              identity,
              Promise.resolve(identity),
              options.concurrency ?? 2,
            )) === "ready";
        }
      }
      client = await connectCurrent();
      if (!client) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!client) throw new ServiceUnavailableError();
  try {
    const status = decodeStatus(await client.request("status"));
    if (
      status.state !== "running" ||
      (options.concurrency !== undefined &&
        status.concurrency !== options.concurrency)
    )
      throw new ServiceUnavailableError();
    return executorForConnection(client);
  } catch (error) {
    await client.close();
    throw error;
  }
}
async function manage(
  op: "status" | "stop",
  options: ServiceOptions,
): Promise<ServiceStatus> {
  let client: ServiceClient | undefined;
  try {
    validateOptions(options);
    const location = await serviceLocation(options.directory),
      state = new ServiceState(location.directory);
    const record = await state.read();
    if (!record) {
      if (op === "stop") {
        // Discovery can disappear before shutdown releases startup ownership.
        // Inspect only an existing lock: management must never create state.
        let lease: StateLease | undefined;
        try {
          lease = await state.lease(undefined, false);
          if (!lease.acquire()) return { state: "unavailable" };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        } finally {
          await lease?.close();
        }
      }
      return { state: "stopped" };
    }
    client = await connectService(state, record);
    const result = await client.request(op);
    if (op === "stop") {
      if (!exactFields(result, ["state"]) || result.state !== "stopped")
        throw new ServiceUnavailableError();
      return { state: "stopped" };
    }
    return decodeStatus(result);
  } catch {
    return { state: "unavailable" };
  } finally {
    await client?.close();
  }
}
export function serviceStatus(
  options: ServiceOptions = {},
): Promise<ServiceStatus> {
  return manage("status", options);
}
export function stopService(
  options: ServiceOptions = {},
): Promise<ServiceStatus> {
  return manage("stop", options);
}
