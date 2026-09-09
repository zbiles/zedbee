import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname } from "node:path";
import {
  AnalyzerCapacityError,
  analyzerRequestRetentionBytes,
  exactFields,
  jobFailure,
} from "../checks/runner/envelope.js";
import {
  validateAnalyzerRequest,
  validateAnalyzerResult,
  type AnalyzerRequest,
  type AnalyzerResult,
} from "../checks/runner/protocol.js";
import type {
  AnalyzerExecutor,
  AnalyzerExecutionSession,
  AnalyzerExecutionSessionOptions,
} from "../checks/runner/executor.js";
import type { AnalyzerJobOptions } from "../checks/runner/run-job.js";
import { AnalyzerJobError } from "../checks/diagnostics.js";
import { CheckIncompleteError } from "../checks/incomplete-error.js";
import {
  ByteBudget,
  GLOBAL_BYTES,
  HEX,
  ServiceUnavailableError,
  proof,
  verifyProof,
} from "./protocol.js";
import { ServiceConnection, serviceEndpoint } from "./transport.js";
import { ServiceState, type ServiceRecord, type StateLease } from "./state.js";
import { stopProcessGroup } from "../checks/runner/process-group.js";
import {
  serviceIdentity,
  serviceLocation,
  type ServiceIdentity,
} from "./identity.js";
import type { ServiceStatus } from "./server.js";

function decodeError(value: unknown): Error {
  if (!exactFields(value, ["code", "scope", "diagnostic", "incomplete"]))
    return new ServiceUnavailableError();
  if (
    value.code === "ANALYZER_CAPACITY" &&
    ["session", "job", "request"].includes(value.scope as string)
  )
    return new AnalyzerCapacityError(
      value.scope as "session" | "job" | "request",
    );
  if (value.code === "analyzer")
    return new AnalyzerJobError(value.diagnostic as any);
  if (value.code === "incomplete")
    return new CheckIncompleteError(value.incomplete as any);
  return new ServiceUnavailableError();
}
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly request?: AnalyzerRequest | undefined;
  readonly cleanup: () => void;
  readonly acknowledgement: boolean;
}
export class ServiceClient {
  private next = 0;
  private pending = new Map<number, Pending>();
  private readonly retained = new ByteBudget(GLOBAL_BYTES);
  private closed = false;
  private cleanup: Promise<void> | undefined;
  private readonly events = new Set<Promise<void>>();
  private readonly leases = new Map<string, StateLease>();
  private readonly trees = new Map<
    string,
    { sessionId: string; stop(): Promise<void>; close(): void }
  >();
  constructor(
    readonly peer: ServiceConnection,
    private readonly state: ServiceState,
  ) {
    peer.socket.once("close", () => {
      this.closed = true;
      for (const [id, pending] of this.pending)
        if (pending.acknowledgement) {
          this.pending.delete(id);
          pending.cleanup();
          pending.reject(new ServiceUnavailableError());
        }
      // Socket loss is not tree/source cleanup. Keep all calls pending until
      // independent OS witnesses prove this client's reads have ended.
      this.cleanup = this.cleanupLost();
      void this.cleanup.then(
        () => this.rejectPending(),
        () => this.rejectPending(true),
      );
    });
  }
  private rejectPending(cleanupFailed = false): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(
        pending.request
          ? jobFailure(
              pending.request,
              cleanupFailed ? "cleanup" : "abnormal-exit",
            )
          : new ServiceUnavailableError(),
      );
    }
    this.pending.clear();
  }
  private async releaseLease(id: string): Promise<void> {
    const lease = this.leases.get(id);
    if (!lease) throw new ServiceUnavailableError();
    while (!lease.acquire())
      await new Promise((resolve) => setTimeout(resolve, 20));
    await lease.close();
    this.leases.delete(id);
    await this.state.removeLease(id);
  }
  private async cleanupLost(): Promise<void> {
    await Promise.allSettled([...this.events]);
    await Promise.all([...this.trees.values()].map((tree) => tree.stop()));
    this.trees.clear();
    await Promise.all(
      [...this.leases.keys()].map((id) => this.releaseLease(id)),
    );
  }
  event(value: Record<string, unknown>): void {
    const operation = this.acceptEvent(value);
    this.events.add(operation);
    void operation
      .catch(() => this.peer.destroy())
      .finally(() => this.events.delete(operation));
  }
  private async acceptEvent(value: Record<string, unknown>): Promise<void> {
    if (
      typeof value.eventId !== "string" ||
      !HEX.test(value.eventId) ||
      typeof value.sessionId !== "string" ||
      !HEX.test(value.sessionId)
    )
      throw new ServiceUnavailableError();
    const id = value.sessionId;
    if (
      value.type === "io-acquire" &&
      exactFields(value, ["type", "eventId", "sessionId"])
    ) {
      if (this.leases.size >= 4 || this.leases.has(id))
        throw new ServiceUnavailableError();
      const lease = await this.state.lease(id, false);
      this.leases.set(id, lease);
    } else if (
      value.type === "io-release" &&
      exactFields(value, ["type", "eventId", "sessionId"])
    ) {
      await this.releaseLease(id);
    } else if (
      value.type === "tree-acquire" &&
      exactFields(value, ["type", "eventId", "sessionId", "witness"])
    ) {
      const witness = value.witness;
      if (
        !this.leases.has(id) ||
        this.trees.size >= 4 ||
        !exactFields(witness, ["id", "kind", "pgid", "jobName"]) ||
        typeof witness.id !== "string" ||
        !HEX.test(witness.id) ||
        this.trees.has(witness.id)
      )
        throw new ServiceUnavailableError();
      if (
        witness.kind === "windows" &&
        process.platform === "win32" &&
        exactFields(witness, ["id", "kind", "jobName"]) &&
        witness.jobName === `Local\\zedbee-${witness.id}`
      ) {
        const owned = (await import("./windows-pipe.js")).openWindowsJobWitness(
          witness.jobName as string,
        );
        this.trees.set(witness.id, { sessionId: id, ...owned });
      } else if (
        witness.kind === "posix" &&
        process.platform !== "win32" &&
        exactFields(witness, ["id", "kind", "pgid"]) &&
        Number.isSafeInteger(witness.pgid) &&
        (witness.pgid as number) > 0
      ) {
        const pgid = witness.pgid as number;
        this.trees.set(witness.id, {
          sessionId: id,
          stop: () => stopProcessGroup(pgid),
          close() {},
        });
      } else throw new ServiceUnavailableError();
    } else if (
      value.type === "tree-release" &&
      exactFields(value, ["type", "eventId", "sessionId", "witnessId"]) &&
      typeof value.witnessId === "string"
    ) {
      const owned = this.trees.get(value.witnessId);
      if (!owned || owned.sessionId !== id) throw new ServiceUnavailableError();
      owned.close();
      this.trees.delete(value.witnessId);
    } else throw new ServiceUnavailableError();
    if (!this.peer.socket.destroyed)
      await this.request("ack", { eventId: value.eventId });
  }
  receive(value: unknown): void {
    if (
      !exactFields(value, ["id", "ok", "result", "error"]) ||
      typeof value.ok !== "boolean" ||
      !Number.isSafeInteger(value.id)
    )
      throw new ServiceUnavailableError();
    const pending = this.pending.get(value.id as number);
    if (!pending) throw new ServiceUnavailableError();
    if (
      !exactFields(
        value,
        value.ok ? ["id", "ok", "result"] : ["id", "ok", "error"],
      )
    )
      throw new ServiceUnavailableError();
    const error = value.ok ? undefined : decodeError(value.error);
    this.pending.delete(value.id as number);
    pending.cleanup();
    if (value.ok) pending.resolve(value.result);
    else pending.reject(error);
  }
  request(
    op: string,
    fields: Record<string, unknown> = {},
    signal?: AbortSignal,
    request?: AnalyzerRequest,
  ): Promise<unknown> {
    if ((this.closed || this.peer.socket.destroyed) && op === "ack")
      return Promise.reject(new ServiceUnavailableError());
    if (this.closed || this.peer.socket.destroyed)
      return this.close().then(() => {
        throw request
          ? jobFailure(request, "abnormal-exit")
          : new ServiceUnavailableError();
      });
    if (this.pending.size >= 32)
      return Promise.reject(new AnalyzerCapacityError("job"));
    if (signal?.aborted)
      return Promise.reject(
        request
          ? jobFailure(request, "cancellation")
          : new ServiceUnavailableError(),
      );
    let releaseRetention: () => void;
    try {
      // Cleanup/control exchanges must remain possible while payload admission
      // is full. Pending accepted source/request objects share one byte budget.
      releaseRetention = this.retained.reserve(
        op === "run" || op === "open"
          ? analyzerRequestRetentionBytes(fields)
          : 0,
      );
    } catch (error) {
      return Promise.reject(error);
    }
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const abort = () => {
        void this.request("cancel", { jobId: id }).catch(() =>
          this.peer.destroy(),
        );
      };
      this.pending.set(id, {
        resolve,
        reject,
        request,
        acknowledgement: op === "ack",
        cleanup: () => {
          releaseRetention();
          signal?.removeEventListener("abort", abort);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      void this.peer.send({ id, op, ...fields }).catch((error) => {
        // Encoding/admission failed synchronously before socket.write: no
        // accepted job exists and the authenticated connection remains usable.
        if (error instanceof AnalyzerCapacityError) {
          const pending = this.pending.get(id);
          this.pending.delete(id);
          pending?.cleanup();
          pending?.reject(error);
        } else this.peer.destroy();
      });
    });
  }
  async close(): Promise<void> {
    if (!this.closed)
      await new Promise<void>((resolve) => {
        this.peer.socket.once("close", resolve);
        this.peer.destroy();
      });
    await this.cleanup;
  }
}
export async function connectService(
  state: ServiceState,
  record: ServiceRecord,
): Promise<ServiceClient> {
  const socket = connect(serviceEndpoint(state, record.instance));
  let phase = 0,
    client: ServiceClient | undefined;
  const nonce = randomBytes(32).toString("hex");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => socket.destroy(), 10000);
    socket.once("close", () => {
      clearTimeout(timer);
      if (!client) reject(new ServiceUnavailableError());
    });
    const peer = new ServiceConnection(
      socket,
      new ByteBudget(GLOBAL_BYTES),
      new ByteBudget(GLOBAL_BYTES),
      (value, release) => {
        try {
          if (client) {
            if (
              exactFields(value, [
                "type",
                "eventId",
                "sessionId",
                "witness",
                "witnessId",
              ]) &&
              typeof value.type === "string"
            )
              client.event(value);
            else client.receive(value);
          } else if (
            phase === 0 &&
            exactFields(value, ["type", "nonce", "proof"]) &&
            value.type === "challenge" &&
            typeof value.nonce === "string" &&
            HEX.test(value.nonce) &&
            verifyProof(
              value.proof,
              record.secret,
              "server",
              record.identity,
              nonce,
              value.nonce,
            )
          ) {
            phase = 1;
            void peer
              .send({
                type: "authenticate",
                proof: proof(
                  record.secret,
                  "client",
                  record.identity,
                  nonce,
                  value.nonce,
                ),
              })
              .catch(() => socket.destroy());
          } else if (
            phase === 1 &&
            exactFields(value, ["type"]) &&
            value.type === "authenticated"
          ) {
            clearTimeout(timer);
            peer.authenticated();
            client = new ServiceClient(peer, state);
            resolve(client);
          } else throw new ServiceUnavailableError();
        } catch {
          socket.destroy();
        } finally {
          release();
        }
      },
    );
    socket.once("connect", () => {
      void peer
        .send({ type: "hello", identity: record.identity, nonce })
        .catch(() => socket.destroy());
    });
  });
}
export function executorForConnection(client: ServiceClient): AnalyzerExecutor {
  const sessions = new Set<AnalyzerExecutionSession>();
  let closed = false,
    closing: Promise<void> | undefined;
  return {
    async openSession(options: AnalyzerExecutionSessionOptions = {}) {
      if (closed) throw new ServiceUnavailableError();
      analyzerRequestRetentionBytes(options);
      if (!exactFields(options, ["sourceSelections"]))
        throw new ServiceUnavailableError();
      const result = await client.request("open", { options });
      if (
        !exactFields(result, ["sessionId"]) ||
        typeof result.sessionId !== "string" ||
        !HEX.test(result.sessionId)
      )
        throw new ServiceUnavailableError();
      const sessionId = result.sessionId;
      let released = false,
        release: Promise<void> | undefined;
      const session: AnalyzerExecutionSession = {
        async run<R extends AnalyzerRequest>(
          request: R,
          options: AnalyzerJobOptions = {},
        ): Promise<AnalyzerResult<R>> {
          if (released || closed) throw new ServiceUnavailableError();
          const signal = options.signal;
          if (!exactFields(options, ["signal"]))
            throw new ServiceUnavailableError();
          analyzerRequestRetentionBytes(request);
          const captured = structuredClone(request);
          validateAnalyzerRequest(captured);
          return validateAnalyzerResult(
            captured,
            await client.request(
              "run",
              { sessionId, request: captured },
              signal,
              captured,
            ),
          );
        },
        close() {
          if (!release) {
            released = true;
            release = client.request("close", { sessionId }).then(() => {
              sessions.delete(session);
            });
          }
          return release;
        },
      };
      sessions.add(session);
      if (closed) {
        await session.close();
        throw new ServiceUnavailableError();
      }
      return session;
    },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          try {
            const results = await Promise.allSettled(
              [...sessions].map((session) => session.close()),
            );
            const failure = results.find(
              (result) => result.status === "rejected",
            );
            if (failure?.status === "rejected") throw failure.reason;
          } finally {
            await client.close();
          }
        })();
      }
      return closing;
    },
  };
}

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
async function startCandidate(
  location: Pick<ServiceIdentity, "key" | "entry" | "directory">,
  pendingIdentity: Promise<ServiceIdentity>,
  concurrency: 1 | 2 | 4,
): Promise<void> {
  const execArgv = location.entry.endsWith(".ts")
    ? ["--import", import.meta.resolve("tsx")]
    : [];
  const child = spawn(process.execPath, [...execArgv, location.entry], {
    // The service outlives its initiating checkout; cwd is not source authority.
    cwd: dirname(location.entry),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    detached: true,
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let settling = false,
      startupSent = false,
      detaching = false;
    let witnessExit!: () => void;
    const exited = new Promise<void>((done) => {
      witnessExit = done;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disconnect = () => {
      if (child.connected) child.disconnect();
    };
    const fail = async () => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      disconnect();
      // A failed detach send may already have reached the child. SIGTERM keeps
      // its existing graceful cleanup path responsible even if it detached.
      if (detaching) child.kill("SIGTERM");
      await exited;
      child.unref();
      reject(new ServiceUnavailableError());
    };
    child.once("error", () => {
      // A spawn error has no process whose exit could witness cleanup.
      if (child.pid === undefined) witnessExit();
      void fail();
    });
    child.once("exit", () => {
      witnessExit();
      if (!settling) void fail();
    });
    child.on("message", (value) => {
      if (settling) return;
      if (!startupSent || detaching || !exactFields(value, ["type"])) {
        void fail();
        return;
      }
      if (value.type === "ready") {
        detaching = true;
        try {
          child.send({ type: "detach" }, (error) => {
            if (error) {
              void fail();
              return;
            }
            if (settling) return;
            settling = true;
            clearTimeout(timer);
            child.unref();
            disconnect();
            resolve();
          });
        } catch {
          void fail();
        }
      } else if (value.type === "busy") {
        settling = true;
        clearTimeout(timer);
        disconnect();
        void exited.then(() => {
          child.unref();
          resolve();
        });
      } else void fail();
    });
    void pendingIdentity
      .then((identity) => {
        if (settling) return;
        if (
          identity.key !== location.key ||
          identity.directory !== location.directory ||
          identity.entry !== location.entry
        ) {
          void fail();
          return;
        }
        // The caller's full identity is owned computation, not startup IPC.
        // Preserve the exchange bound only after that work and validation;
        // failure still awaits the candidate's cleanup and actual exit.
        timer = setTimeout(() => {
          void fail();
        }, 30000);
        startupSent = true;
        child.send(
          {
            directory: identity.directory,
            identity: identity.content,
            concurrency,
          },
          (error) => {
            if (error) void fail();
          },
        );
      })
      .catch(() => {
        void fail();
      });
  });
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
  if (candidate) await candidate;
  const connectCurrent = async (): Promise<ServiceClient | undefined> => {
    const record = await state.read();
    if (!record) return undefined;
    if (record.identity !== identity.content) return undefined;
    try {
      return await connectService(state, record);
    } catch {
      return undefined;
    }
  };
  let client = await connectCurrent();
  if (!client) {
    // A busy/ready early candidate has already attempted startup. Poll its
    // discovery race rather than launching another candidate and repeating I/O.
    if (!candidate)
      await startCandidate(
        identity,
        Promise.resolve(identity),
        options.concurrency ?? 2,
      );
    const start = performance.now();
    while (!client && performance.now() - start < 30000) {
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
