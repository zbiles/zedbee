import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createLocalAnalyzerExecutor,
  type AnalyzerExecutionSession,
} from "../checks/runner/executor.js";
import { LeaseRemovalDeferredError, type StateLease } from "./state.js";
import {
  ByteBudget,
  GLOBAL_BYTES,
  ServiceUnavailableError,
} from "./protocol.js";
import { listenPrivate, type ServiceConnection } from "./transport.js";
import { RETAINED_RESULT_BYTES } from "./large-result.js";
import type { ServiceState } from "./state.js";
import {
  acceptServiceConnection,
  type ServiceConnectionHost,
  type SessionOwner,
} from "./server-connection.js";

export type ServiceStatus =
  | { readonly state: "stopped" }
  | { readonly state: "unavailable" }
  | {
      readonly state: "running";
      readonly pid: number;
      readonly activeSessions: number;
      readonly concurrency: 1 | 2 | 4;
    };
export class IdleLifetime {
  active = 0;
  private idleSince: number;
  constructor(private readonly clock: () => number = () => performance.now()) {
    this.idleSince = clock();
  }
  get expired(): boolean {
    return this.active === 0 && this.clock() - this.idleSince >= 300000;
  }
  open(): void {
    this.active++;
  }
  close(): void {
    if (--this.active === 0) this.idleSince = this.clock();
  }
}
export async function startServiceServer(
  state: ServiceState,
  identity: string,
  concurrency: 1 | 2 | 4,
  releaseOwnership: () => Promise<void>,
) {
  const resultOutput = new ByteBudget(RETAINED_RESULT_BYTES);
  const instance = randomBytes(32).toString("hex"),
    secret = randomBytes(32).toString("hex");
  const owners = new WeakMap<AnalyzerExecutionSession, SessionOwner>();
  const executor = createLocalAnalyzerExecutor({
      concurrency,
      ownership: {
        acquire(session, witness) {
          const owner = owners.get(session);
          if (!owner) throw new ServiceUnavailableError();
          return owner.exchange("tree-acquire", {
            sessionId: owner.sessionId,
            witness,
          });
        },
        release(session, witness) {
          const owner = owners.get(session);
          if (!owner) throw new ServiceUnavailableError();
          return owner.exchange("tree-release", {
            sessionId: owner.sessionId,
            witnessId: witness.id,
          });
        },
      },
    }),
    idle = new IdleLifetime();
  const input = new ByteBudget(GLOBAL_BYTES),
    decoded = new ByteBudget(GLOBAL_BYTES),
    output = new ByteBudget(GLOBAL_BYTES);
  const clients = new Set<ServiceConnection>(),
    cleaning = new Set<Promise<void>>();
  let draining = false,
    stopping = false,
    cleanupFailed = false,
    closing: Promise<void> | undefined,
    operations = 0;
  const status = (): ServiceStatus => ({
    state: "running",
    pid: process.pid,
    activeSessions: idle.active,
    concurrency,
  });
  const host: ServiceConnectionHost = {
    state,
    identity,
    secret,
    executor,
    input,
    decoded,
    output,
    resultOutput,
    get stopping() {
      return stopping;
    },
    get draining() {
      return draining;
    },
    get activeSessions() {
      return idle.active;
    },
    status,
    operationsFull: () => operations >= 128,
    admitOperation() {
      operations++;
    },
    releaseOperation() {
      operations--;
    },
    reserveSession() {
      idle.open();
    },
    releaseSession() {
      idle.close();
    },
    ownSession(session, owner) {
      owners.set(session, owner);
    },
    cleaning(peer, cleanup) {
      cleaning.add(cleanup);
      void cleanup
        .catch(() => {
          cleanupFailed = true;
          // Preserve failed cleanup as a rejected shutdown, without an unhandled rejection.
          void close().catch(() => {});
        })
        .finally(() => {
          cleaning.delete(cleanup);
          clients.delete(peer);
        });
    },
    async stop(request) {
      // Drain admission changes synchronously before an already admitted open
      // can yield. Those sessions retain their ownership until they close.
      if (request.drain) draining = true;
      const id = randomBytes(32).toString("hex");
      const lease = await state.lease(id);
      let retained = false;
      try {
        if (!lease.acquire()) throw new ServiceUnavailableError();
        // Hand off the source-free cleanup witness before the provisional reply.
        await request.exchange("io-acquire", { sessionId: id });
        if (request.drain) {
          while (idle.active > 0 && !request.peer.socket.destroyed && !stopping)
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (request.peer.socket.destroyed || stopping)
          throw new ServiceUnavailableError();
        retained = true;
        request.accepted();
        await close(request.peer, request.id, lease);
      } finally {
        if (!retained) {
          await lease.close();
          try {
            await state.removeLease(id);
          } catch (error) {
            // A surviving Windows client pins and removes the exact lease.
            if (!(error instanceof LeaseRemovalDeferredError)) throw error;
          }
        }
      }
    },
  };
  const server = await listenPrivate(state, instance, (socket) => {
    if (stopping || clients.size >= 16) {
      socket.destroy();
      return;
    }
    clients.add(acceptServiceConnection(socket, host));
  });
  // Time is measured from the last completed release; requests/status cannot
  // extend an idle lifetime. This never imposes a deadline on an analyzer.
  const timer = setInterval(() => {
    if (idle.expired) void close().catch(() => {});
  }, 1000);
  function close(
    preserve?: ServiceConnection,
    stopId?: number,
    completion?: StateLease,
  ): Promise<void> {
    if (!closing) {
      stopping = true;
      clearInterval(timer);
      closing = (async () => {
        const listenerClosed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await executor.close();
        for (const client of clients) if (client !== preserve) client.destroy();
        await Promise.all([...cleaning]);
        await state.clear(instance);
        if (preserve) {
          await preserve.send({
            id: stopId,
            ok: true,
            result: { state: "stopped" },
          });
          preserve.socket.end();
          preserve.socket.once("finish", () => preserve.destroy());
        }
        await listenerClosed;
        // Socket close handlers start asynchronously after destroy(). Now all
        // have run: drain their state I/O before releasing either final witness.
        await Promise.all([...cleaning]);
        if (cleanupFailed) throw new ServiceUnavailableError();
        await releaseOwnership();
        // Never release this witness in finally: failed endpoint/startup
        // cleanup must retain it until OS process death supplies the proof.
        // This is the final server-owned state operation. The authenticated
        // client alone removes this unique completion file; client death may
        // leave an inert zero-byte file, never a live ownership claim.
        await completion?.close();
      })();
    }
    return closing;
  }
  try {
    await state.publish({ version: 1, identity, instance, secret });
  } catch (error) {
    await close();
    throw error;
  }
  return { status, close, instance };
}
