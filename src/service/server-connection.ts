import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import type {
  AnalyzerExecutor,
  AnalyzerExecutionSession,
} from "../checks/runner/executor.js";
import {
  LeaseRemovalDeferredError,
  type ServiceState,
  type StateLease,
} from "./state.js";
import {
  AnalyzerCapacityError,
  analyzerRequestRetentionBytes,
  exactFields,
} from "../checks/runner/envelope.js";
import type { AnalyzerRequest } from "../checks/runner/protocol.js";
import { AnalyzerJobError } from "../checks/diagnostics.js";
import { CheckIncompleteError } from "../checks/incomplete-error.js";
import {
  type ByteBudget,
  HEX,
  ServiceUnavailableError,
  proof,
  verifyProof,
} from "./protocol.js";
import { ServiceConnection } from "./transport.js";
import type { ServiceStatus } from "./server.js";

export interface SessionOwner {
  readonly sessionId: string;
  exchange(type: string, fields: object): Promise<void>;
}
export interface ServiceStopRequest {
  readonly peer: ServiceConnection;
  readonly id: number;
  readonly drain: boolean;
  exchange(type: string, fields: object): Promise<void>;
  /** Exclude only the stop that owns shutdown from its connection's cleanup. */
  accepted(): void;
}
/** Whole-service authority stays with the host; all session/job maps stay local. */
export interface ServiceConnectionHost {
  readonly state: Pick<ServiceState, "lease" | "removeLease">;
  readonly identity: string;
  readonly secret: string;
  readonly executor: Pick<AnalyzerExecutor, "openSession">;
  readonly input: ByteBudget;
  readonly output: ByteBudget;
  readonly decoded: ByteBudget;
  readonly resultOutput: ByteBudget;
  readonly stopping: boolean;
  readonly draining: boolean;
  readonly activeSessions: number;
  status(): ServiceStatus;
  operationsFull(): boolean;
  admitOperation(): void;
  releaseOperation(): void;
  reserveSession(): void;
  releaseSession(): void;
  ownSession(session: AnalyzerExecutionSession, owner: SessionOwner): void;
  cleaning(peer: ServiceConnection, cleanup: Promise<void>): void;
  stop(request: ServiceStopRequest): Promise<void>;
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
export function acceptServiceConnection(
  socket: Socket,
  host: ServiceConnectionHost,
): ServiceConnection {
  const sessions = new Map<string, AnalyzerExecutionSession>();
  const leases = new Map<string, StateLease>();
  const exchanges = new Map<
    string,
    { resolve(): void; reject(error: Error): void }
  >();
  const inFlight = new Map<number, Promise<unknown>>();
  let stopRequestId: number | undefined;
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
    host.input,
    host.output,
    (value, release) => {
      if (phase < 2) {
        try {
          if (
            phase === 0 &&
            exactFields(value, ["type", "identity", "nonce"]) &&
            value.type === "hello" &&
            value.identity === host.identity &&
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
                  host.secret,
                  "server",
                  host.identity,
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
              host.secret,
              "client",
              host.identity,
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
      let admittedId: number | undefined;
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
        admittedId = id;
        if (pending >= 16 || host.operationsFull())
          throw new AnalyzerCapacityError("job");
        releaseDecoded = host.decoded.reserve(
          analyzerRequestRetentionBytes(value),
        );
        pending++;
        host.admitOperation();
        const operation = operate(value);
        inFlight.set(id, operation);
        void operation
          .then(
            (result) =>
              value.op === "stop" || value.op === "drain"
                ? undefined
                : peer.sendResult({ id, ok: true, result }).catch((error) => {
                    if (!(error instanceof AnalyzerCapacityError)) throw error;
                    return peer.send({
                      id,
                      ok: false,
                      error: wireError(
                        new CheckIncompleteError({
                          code: "ANALYZER_RESULT_CAPACITY_EXCEEDED",
                          message:
                            "The analyzer result exceeds the background service's transfer capacity.",
                          remediation:
                            "Retry with --no-service, or scan a smaller set of projects.",
                        }),
                      ),
                    });
                  }),
            (error) => peer.send({ id, ok: false, error: wireError(error) }),
          )
          .catch(() => peer.destroy())
          .finally(() => {
            inFlight.delete(id);
            pending--;
            host.releaseOperation();
            releaseDecoded?.();
            release();
          });
      } catch (error) {
        releaseDecoded?.();
        if (
          error instanceof AnalyzerCapacityError &&
          admittedId !== undefined
        ) {
          void peer
            .send({ id: admittedId, ok: false, error: wireError(error) })
            .catch(() => peer.destroy())
            .finally(release);
        } else {
          release();
          peer.destroy();
        }
      }
    },
    host.resultOutput,
  );
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
      // The stop operation itself awaits server shutdown. Everything else,
      // including competing stop handoffs, must finish its own cleanup.
      await Promise.allSettled(
        [...inFlight]
          .filter(([id]) => id !== stopRequestId)
          .map(([, operation]) => operation),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    host.cleaning(peer, cleanup);
  });
  async function exchange(type: string, fields: object): Promise<void> {
    if (socket.destroyed || host.stopping || exchanges.size >= 8)
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
        host.releaseSession();
        if (!socket.destroyed && !host.stopping)
          await exchange("io-release", { sessionId: id });
        else await removeAbandonedLease(id);
      }
    }
  }
  async function removeAbandonedLease(id: string): Promise<void> {
    try {
      await host.state.removeLease(id);
    } catch (error) {
      // A surviving Windows client pins the exact lease without delete
      // sharing. It removes that lease after independently acquiring it.
      if (!(error instanceof LeaseRemovalDeferredError)) throw error;
    }
  }
  async function operate(value: Record<string, unknown>): Promise<unknown> {
    if (host.stopping) throw new ServiceUnavailableError();
    if (value.op === "status" && exactFields(value, ["id", "op"]))
      return host.status();
    if (
      (value.op === "stop" || value.op === "drain") &&
      exactFields(value, ["id", "op"])
    ) {
      await host.stop({
        peer,
        id: value.id as number,
        drain: value.op === "drain",
        exchange,
        accepted() {
          stopRequestId = value.id as number;
        },
      });
      return { state: "stopped" };
    }
    if (value.op === "open" && exactFields(value, ["id", "op", "options"])) {
      if (host.draining) throw new ServiceUnavailableError();
      if (sessions.size + opening >= 4 || host.activeSessions >= 32)
        throw new AnalyzerCapacityError("session");
      if (!exactFields(value.options, ["sourceSelections"]))
        throw new ServiceUnavailableError();
      opening++;
      host.reserveSession();
      let retained = false;
      const sessionId = randomBytes(32).toString("hex");
      let lease: StateLease | undefined;
      try {
        lease = await host.state.lease(sessionId);
        if (!lease.acquire()) throw new ServiceUnavailableError();
        await exchange("io-acquire", { sessionId });
        if (socket.destroyed || host.stopping)
          throw new ServiceUnavailableError();
        const session = await host.executor.openSession(value.options);
        if (socket.destroyed || host.stopping) {
          await session.close();
          throw new ServiceUnavailableError();
        }
        host.ownSession(session, { sessionId, exchange });
        sessions.set(sessionId, session);
        leases.set(sessionId, lease);
        retained = true;
        return { sessionId };
      } finally {
        opening--;
        if (!retained) {
          await lease?.close();
          host.releaseSession();
          if (lease && !socket.destroyed && !host.stopping)
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
    if (value.op === "close" && exactFields(value, ["id", "op", "sessionId"])) {
      await closeSession(value.sessionId);
      return null;
    }
    if (
      (value.op === "run" || value.op === "run-measured") &&
      exactFields(value, ["id", "op", "sessionId", "request"])
    ) {
      if (jobs.size >= 8) throw new AnalyzerCapacityError("job");
      const id = value.id as number,
        controller = new AbortController();
      jobs.set(id, controller);
      try {
        const timings: {
          kind: "queue" | "worker" | "result";
          durationMs: number;
        }[] = [];
        const result = await session.run(value.request as AnalyzerRequest, {
          signal: controller.signal,
          ...(value.op === "run-measured"
            ? {
                onTiming: (
                  kind: "queue" | "worker" | "result",
                  durationMs: number,
                ) => {
                  timings.push({ kind, durationMs });
                },
              }
            : {}),
        });
        return value.op === "run-measured" ? { result, timings } : result;
      } finally {
        jobs.delete(id);
      }
    }
    throw new ServiceUnavailableError();
  }
  return peer;
}
