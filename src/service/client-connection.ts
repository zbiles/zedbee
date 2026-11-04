import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import {
  AnalyzerCapacityError,
  analyzerRequestRetentionBytes,
  exactFields,
  jobFailure,
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
import { ServiceConnection, serviceEndpoint } from "./transport.js";
import { type ServiceState, type ServiceRecord } from "./state.js";
import { ClientOwnership } from "./client-ownership.js";

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
  private readonly ownership: ClientOwnership;
  constructor(
    readonly peer: ServiceConnection,
    state: Pick<ServiceState, "lease" | "removeLease">,
  ) {
    this.ownership = new ClientOwnership(
      state,
      (eventId) => this.request("ack", { eventId }),
      () => !peer.socket.destroyed,
    );
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
      this.cleanup = this.ownership.close();
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
  event(value: Record<string, unknown>): void {
    void this.ownership.accept(value).catch(() => this.peer.destroy());
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
  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.request("close", { sessionId });
    } catch (error) {
      if (!this.closed && !this.peer.socket.destroyed) throw error;
      // Disconnect is not proof. Only successful settlement of the independent
      // process-tree and source-lease witnesses permits snapshot deletion.
      await this.close();
    }
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
            peer.authenticated(true);
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
