import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createLocalAnalyzerExecutor,
  type AnalyzerExecutionSession,
} from "../checks/runner/executor.js";
import type { StateLease } from "./state.js";
import {
  AnalyzerCapacityError,
  analyzerRequestRetentionBytes,
  exactFields,
} from "../checks/runner/envelope.js";
import type { AnalyzerRequest } from "../checks/runner/protocol.js";
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
import { ServiceConnection, listenPrivate } from "./transport.js";
import type { ServiceState } from "./state.js";

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
function wireError(error: unknown): object {
  if (error instanceof AnalyzerCapacityError)
    return { code: error.code, scope: error.scope };
  if (error instanceof CheckIncompleteError) {
    const {
      code,
      message,
      remediation,
      path,
      paths,
      snapshot,
      projectPaths,
      disposition,
      diagnostic,
    } = error;
    return {
      code: "incomplete",
      incomplete: {
        code,
        message,
        remediation,
        path,
        paths,
        snapshot,
        projectPaths,
        disposition,
        diagnostic,
      },
    };
  }
  if (error instanceof AnalyzerJobError)
    return { code: "analyzer", diagnostic: error.diagnostic };
  return { code: "unavailable" };
}
export async function startServiceServer(
  state: ServiceState,
  identity: string,
  concurrency: 1 | 2 | 4,
  releaseOwnership: () => Promise<void>,
) {
  const instance = randomBytes(32).toString("hex"),
    secret = randomBytes(32).toString("hex");
  type Owner = {
    sessionId: string;
    exchange(type: string, fields: object): Promise<void>;
  };
  const owners = new WeakMap<AnalyzerExecutionSession, Owner>();
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
  let stopping = false,
    closing: Promise<void> | undefined,
    operations = 0;
  const status = (): ServiceStatus => ({
    state: "running",
    pid: process.pid,
    activeSessions: idle.active,
    concurrency,
  });
  const server = await listenPrivate(state, instance, (socket) => {
    if (stopping || clients.size >= 16) {
      socket.destroy();
      return;
    }
    const sessions = new Map<string, AnalyzerExecutionSession>();
    const leases = new Map<string, StateLease>();
    const exchanges = new Map<
      string,
      { resolve(): void; reject(error: Error): void }
    >();
    const inFlight = new Set<Promise<unknown>>();
    const jobs = new Map<number, AbortController>();
    let phase = 0,
      clientNonce = "",
      serverNonce = "",
      lastId = 0,
      pending = 0,
      opening = 0;
    // Deadline only for unauthenticated peers to prevent exhausting client slots.
    const handshake = setTimeout(() => socket.destroy(), 10000);
    const peer = new ServiceConnection(
      socket,
      input,
      output,
      (value, release) => {
        if (phase < 2) {
          try {
            if (
              phase === 0 &&
              exactFields(value, ["type", "identity", "nonce"]) &&
              value.type === "hello" &&
              value.identity === identity &&
              typeof value.nonce === "string" &&
              HEX.test(value.nonce)
            ) {
              phase = 1;
              clientNonce = value.nonce;
              serverNonce = randomBytes(32).toString("hex");
              void peer
                .send({
                  type: "challenge",
                  nonce: serverNonce,
                  proof: proof(
                    secret,
                    "server",
                    identity,
                    clientNonce,
                    serverNonce,
                  ),
                })
                .catch(() => peer.destroy());
            } else if (
              phase === 1 &&
              exactFields(value, ["type", "proof"]) &&
              value.type === "authenticate" &&
              verifyProof(
                value.proof,
                secret,
                "client",
                identity,
                clientNonce,
                serverNonce,
              )
            ) {
              phase = 2;
              clearTimeout(handshake);
              peer.authenticated();
              void peer
                .send({ type: "authenticated" })
                .catch(() => peer.destroy());
            } else peer.destroy();
          } finally {
            release();
          }
          return;
        }
        let releaseDecoded: (() => void) | undefined;
        try {
          if (
            exactFields(value, ["id", "op", "eventId"]) &&
            value.op === "ack" &&
            typeof value.eventId === "string" &&
            HEX.test(value.eventId) &&
            Number.isSafeInteger(value.id) &&
            (value.id as number) > lastId
          ) {
            lastId = value.id as number;
            const exchange = exchanges.get(value.eventId);
            if (!exchange) throw new ServiceUnavailableError();
            exchanges.delete(value.eventId);
            exchange.resolve();
            void peer
              .send({ id: value.id, ok: true, result: null })
              .catch(() => peer.destroy());
            release();
            return;
          }
          if (pending >= 16 || operations >= 128)
            throw new AnalyzerCapacityError("job");
          releaseDecoded = decoded.reserve(
            analyzerRequestRetentionBytes(value),
          );
          if (
            !exactFields(value, [
              "id",
              "op",
              "sessionId",
              "request",
              "options",
              "jobId",
            ]) ||
            !Number.isSafeInteger(value.id) ||
            (value.id as number) <= lastId ||
            typeof value.op !== "string"
          )
            throw new ServiceUnavailableError();
          const id = value.id as number;
          lastId = id;
          pending++;
          operations++;
          const operation = operate(value);
          inFlight.add(operation);
          void operation
            .then(
              (result) =>
                value.op === "stop"
                  ? undefined
                  : peer.send({ id, ok: true, result }),
              (error) => peer.send({ id, ok: false, error: wireError(error) }),
            )
            .catch(() => peer.destroy())
            .finally(() => {
              inFlight.delete(operation);
              pending--;
              operations--;
              releaseDecoded?.();
              release();
            });
        } catch {
          releaseDecoded?.();
          release();
          peer.destroy();
        }
      },
    );
    clients.add(peer);
    socket.once("close", () => {
      clearTimeout(handshake);
      for (const job of jobs.values()) job.abort();
      for (const exchange of exchanges.values())
        exchange.reject(new ServiceUnavailableError());
      exchanges.clear();
      const cleanup = (async () => {
        const results = await Promise.allSettled(
          [...sessions.entries()].map(([id]) => closeSession(id)),
        );
        await Promise.allSettled([...inFlight]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
      cleaning.add(cleanup);
      void cleanup
        .catch(() => close())
        .finally(() => {
          cleaning.delete(cleanup);
          clients.delete(peer);
        });
    });
    async function exchange(type: string, fields: object): Promise<void> {
      if (socket.destroyed || stopping || exchanges.size >= 8)
        throw new ServiceUnavailableError();
      const eventId = randomBytes(32).toString("hex");
      const acknowledged = new Promise<void>((resolve, reject) =>
        exchanges.set(eventId, { resolve, reject }),
      );
      try {
        await peer.send({ type, eventId, ...fields });
        await acknowledged;
      } catch (error) {
        exchanges.get(eventId)?.reject(new ServiceUnavailableError());
        await acknowledged.catch(() => {});
        throw error;
      } finally {
        exchanges.delete(eventId);
      }
    }
    async function closeSession(id: string): Promise<void> {
      const session = sessions.get(id);
      if (!session) throw new ServiceUnavailableError();
      // Keep the reservation until cancellation/reset and tree cleanup finish.
      try {
        await session.close();
      } finally {
        if (sessions.delete(id)) {
          await leases.get(id)?.close();
          leases.delete(id);
          idle.close();
          if (!socket.destroyed && !stopping)
            await exchange("io-release", { sessionId: id });
          else await removeAbandonedLease(id);
        }
      }
    }
    async function removeAbandonedLease(id: string): Promise<void> {
      try {
        await state.removeLease(id);
      } catch (error) {
        // A surviving Windows client pins the exact lease without delete
        // sharing. It removes that lease after independently acquiring it.
        if (
          process.platform !== "win32" ||
          !["EPERM", "EACCES"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    }
    async function operate(value: Record<string, unknown>): Promise<unknown> {
      if (stopping) throw new ServiceUnavailableError();
      if (value.op === "status" && exactFields(value, ["id", "op"]))
        return status();
      if (value.op === "stop" && exactFields(value, ["id", "op"])) {
        await close(peer, value.id as number);
        return { state: "stopped" };
      }
      if (value.op === "open" && exactFields(value, ["id", "op", "options"])) {
        if (sessions.size + opening >= 4 || idle.active >= 32)
          throw new AnalyzerCapacityError("session");
        if (!exactFields(value.options, ["sourceSelections"]))
          throw new ServiceUnavailableError();
        opening++;
        idle.open();
        let retained = false;
        const sessionId = randomBytes(32).toString("hex");
        let lease: StateLease | undefined;
        try {
          lease = await state.lease(sessionId);
          if (!lease.acquire()) throw new ServiceUnavailableError();
          await exchange("io-acquire", { sessionId });
          if (socket.destroyed || stopping) throw new ServiceUnavailableError();
          const session = await executor.openSession(value.options);
          if (socket.destroyed || stopping) {
            await session.close();
            throw new ServiceUnavailableError();
          }
          owners.set(session, { sessionId, exchange });
          sessions.set(sessionId, session);
          leases.set(sessionId, lease);
          retained = true;
          return { sessionId };
        } finally {
          opening--;
          if (!retained) {
            await lease?.close();
            idle.close();
            if (lease && !socket.destroyed && !stopping)
              await exchange("io-release", { sessionId });
            else if (lease) await removeAbandonedLease(sessionId);
          }
        }
      }
      if (
        value.op === "cancel" &&
        exactFields(value, ["id", "op", "jobId"]) &&
        Number.isSafeInteger(value.jobId)
      ) {
        jobs.get(value.jobId as number)?.abort();
        return null;
      }
      if (typeof value.sessionId !== "string")
        throw new ServiceUnavailableError();
      const session = sessions.get(value.sessionId);
      if (!session) throw new ServiceUnavailableError();
      if (
        value.op === "close" &&
        exactFields(value, ["id", "op", "sessionId"])
      ) {
        await closeSession(value.sessionId);
        return null;
      }
      if (
        value.op === "run" &&
        exactFields(value, ["id", "op", "sessionId", "request"])
      ) {
        if (jobs.size >= 8) throw new AnalyzerCapacityError("job");
        const id = value.id as number,
          controller = new AbortController();
        jobs.set(id, controller);
        try {
          return await session.run(value.request as AnalyzerRequest, {
            signal: controller.signal,
          });
        } finally {
          jobs.delete(id);
        }
      }
      throw new ServiceUnavailableError();
    }
  });
  // Time is measured from the last completed release; requests/status cannot
  // extend an idle lifetime. This never imposes a deadline on an analyzer.
  const timer = setInterval(() => {
    if (idle.expired) void close().catch(() => {});
  }, 1000);
  function close(preserve?: ServiceConnection, stopId?: number): Promise<void> {
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
        await releaseOwnership();
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
