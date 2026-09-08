import {
  spawn,
  type ChildProcess,
  type Serializable,
} from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  decodeWorkerResponse,
  exactFields,
  jobFailure,
  matchingIdentity,
  type JobIdentity,
} from "./envelope.js";
import { stopProcessGroup } from "./process-group.js";
import type { WindowsJob } from "./windows-job.js";
import type { AnalyzerJobOptions } from "./run-job.js";
import type { AnalyzerRequest } from "./protocol.js";
export type WorkerOutcome = { result: unknown } | { error: Error };
export type AnalyzerTreeWitness =
  | { readonly id: string; readonly kind: "posix"; readonly pgid: number }
  | { readonly id: string; readonly kind: "windows"; readonly jobName: string };
export interface WorkerOwnershipHooks {
  acquire(witness: AnalyzerTreeWitness): Promise<void>;
  release(witness: AnalyzerTreeWitness): Promise<void>;
}
export interface WorkerSession {
  readonly id: string;
  readonly closed: boolean;
  releaseFailure?: Error;
  readonly ownership?: WorkerOwnershipHooks | undefined;
}
export interface WorkerJob extends JobIdentity {
  readonly request: AnalyzerRequest;
  readonly options: AnalyzerJobOptions;
  readonly session: WorkerSession;
  provisional?: WorkerOutcome | undefined;
  complete(outcome: WorkerOutcome): void;
}
const source = import.meta.url.endsWith(".ts");
const extension = source ? "ts" : "js";
export const defaultWorkerEntry = fileURLToPath(
  new URL(`./worker.${extension}`, import.meta.url),
);
const supervisorEntry = fileURLToPath(
  new URL(`./supervisor.${extension}`, import.meta.url),
);
const execArgv = source ? ["--import", import.meta.resolve("tsx")] : [];
/** One supervised process connection. Scheduling and admission belong to its owner. */
export class SupervisedWorkerSlot {
  private child?: ChildProcess;
  private windowsJob?: WindowsJob;
  private workerGroup?: number;
  private readonly witnessId = randomBytes(32).toString("hex");
  private jobName?: string;
  private witness?: AnalyzerTreeWitness;
  private witnessOwner?: WorkerSession | undefined;
  private acknowledgingRelease = false;
  job?: WorkerJob | undefined;
  session?: WorkerSession | undefined;
  affinity?: string;
  stopping = false;
  readonly closed: Promise<void>;
  private finish!: () => void;
  releasing?:
    | {
        sessionId: string;
        promise: Promise<void>;
        resolve: () => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  private failure?: Error;
  private cleanupFailure?: Error;
  private response?: unknown;
  constructor(
    readonly entry: string,
    private readonly onClosed: () => void,
    private readonly onAvailable: () => void,
  ) {
    this.closed = new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }
  async dispatch(envelope: unknown): Promise<void> {
    if (!this.child) await this.start(envelope);
    else {
      try {
        await this.acquireOwnership();
      } catch {
        this.stop(
          this.job
            ? jobFailure(this.job.request, "cleanup")
            : new Error("Analyzer ownership failed."),
        );
        return;
      }
      this.child.ref();
      this.child.channel?.ref();
      this.child.send(envelope as Serializable, (error) => {
        if (error)
          this.stop(
            this.job
              ? jobFailure(this.job.request, "startup")
              : new Error("Analyzer process failed."),
          );
      });
    }
  }
  private async acquireOwnership(): Promise<void> {
    const session = this.session;
    if (!session?.ownership || this.witnessOwner === session) return;
    if (this.workerGroup === undefined)
      throw new Error("Missing owned worker.");
    this.witness ??= this.jobName
      ? { id: this.witnessId, kind: "windows", jobName: this.jobName }
      : { id: this.witnessId, kind: "posix", pgid: this.workerGroup };
    // Record before awaiting: a lost ACK still requires retirement/release.
    this.witnessOwner = session;
    await session.ownership.acquire(this.witness);
    if (this.stopping || session.closed)
      throw new Error("Analyzer ownership ended.");
  }
  private async releaseOwnership(): Promise<void> {
    const owner = this.witnessOwner;
    if (owner?.ownership && this.witness)
      await owner.ownership.release(this.witness);
    this.witnessOwner = undefined;
  }
  private async start(envelope: unknown): Promise<void> {
    const slot = this;
    const job = slot.job!;
    try {
      if (!existsSync(slot.entry)) throw new Error("Missing worker");
      if (process.platform === "win32") {
        if (slot.session?.ownership)
          slot.jobName = `Local\\zedbee-${slot.witnessId}`;
        slot.windowsJob = (await import("./windows-job.js")).createWindowsJob(
          slot.jobName,
        );
      }
      if (slot.stopping || job.options.signal?.aborted || job.session.closed)
        throw new Error("Cancelled");
    } catch {
      let cleanupFailed = false;
      try {
        slot.windowsJob?.close();
      } catch {
        cleanupFailed = true;
      }
      job.complete({
        error: jobFailure(
          job.request,
          cleanupFailed
            ? "cleanup"
            : job.options.signal?.aborted || job.session.closed
              ? "cancellation"
              : "startup",
        ),
      });
      slot.job = undefined;
      this.onClosed();
      slot.finish();
      return;
    }
    const child = spawn(process.execPath, [...execArgv, supervisorEntry], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      serialization: "advanced",
    });
    slot.child = child;
    child.on("error", () =>
      this.stop(
        slot.job
          ? jobFailure(slot.job.request, "startup")
          : new Error("Analyzer process failed."),
      ),
    );
    child.on("message", (message) => this.message(message));
    child.on("close", (code, signal) => {
      void this.stopped(code, signal);
    });
    child.once("spawn", () => {
      try {
        if (child.pid === undefined) throw new Error("Missing supervisor");
        slot.windowsJob?.assign(child.pid);
        child.send(
          {
            type: "start",
            workerEntry: slot.entry,
            execArgv,
            request: envelope,
          } as Serializable,
          (error) => {
            if (error)
              this.stop(
                slot.job
                  ? jobFailure(slot.job.request, "startup")
                  : new Error("Analyzer process failed."),
              );
          },
        );
        envelope = undefined;
      } catch {
        this.stop(
          slot.job
            ? jobFailure(slot.job.request, "startup")
            : new Error("Analyzer process failed."),
        );
        child.kill("SIGKILL");
      }
    });
  }
  private message(value: unknown): void {
    const slot = this;
    if (slot.stopping) {
      if (exactFields(value, ["type", "response"]) && value.type === "result")
        slot.response = value.response;
      return;
    }
    const invalid = () =>
      this.stop(
        slot.job
          ? jobFailure(slot.job.request, "invalid-response")
          : new Error("Invalid analyzer response."),
      );
    if (
      exactFields(value, ["type", "pid"]) &&
      value.type === "worker-owned" &&
      Number.isSafeInteger(value.pid) &&
      (value.pid as number) > 0 &&
      slot.workerGroup === undefined
    ) {
      slot.workerGroup = value.pid as number;
      void slot
        .acquireOwnership()
        .then(() => {
          if (!slot.stopping)
            slot.child!.send({ type: "ownership-ack" }, () => {});
        })
        .catch(() => invalid());
      return;
    }
    if (exactFields(value, ["type", "response"]) && value.type === "result") {
      slot.response = value.response;
      return;
    }
    if (
      !exactFields(value, ["type", "message"]) ||
      value.type !== "worker-message"
    ) {
      invalid();
      return;
    }
    const event = value.message;
    if (slot.releasing) {
      if (
        slot.acknowledgingRelease ||
        !exactFields(event, ["version", "type", "sessionId", "retire"]) ||
        event.version !== 1 ||
        event.type !== "released" ||
        event.sessionId !== slot.releasing.sessionId ||
        typeof event.retire !== "boolean"
      ) {
        invalid();
        return;
      }
      if (event.retire) {
        this.stop();
        return;
      }
      slot.acknowledgingRelease = true;
      void slot
        .releaseOwnership()
        .then(() => {
          if (slot.stopping) return;
          slot.session = undefined;
          const release = slot.releasing!;
          slot.releasing = undefined;
          slot.acknowledgingRelease = false;
          slot.child!.unref();
          slot.child!.channel?.unref();
          release.resolve();
          this.onAvailable();
        })
        // Lost ownership ACK forbids reuse, but retirement with proven OS
        // cleanup is not itself a source-cleanup failure for another session.
        .catch(() => this.stop());
      return;
    }
    const job = slot.job;
    if (!job) {
      invalid();
      return;
    }
    if (
      matchingIdentity(event, job, "result", ["response"]) &&
      job.provisional === undefined
    ) {
      try {
        job.provisional = decodeWorkerResponse(job.request, event.response);
        if ("error" in job.provisional) this.stop(job.provisional.error);
      } catch {
        invalid();
      }
      return;
    }
    if (
      matchingIdentity(event, job, "ready") &&
      job.provisional !== undefined
    ) {
      const outcome = job.provisional;
      slot.job = undefined;
      job.complete(outcome);
      this.onAvailable();
      return;
    }
    invalid();
  }
  stop(failure?: Error, cancelled = false): void {
    const slot = this;
    if (failure && !slot.failure) slot.failure = failure;
    if (slot.stopping) return;
    slot.stopping = true;
    slot.child?.ref();
    slot.child?.channel?.ref();
    if (slot.child?.connected)
      slot.child.send({ type: cancelled ? "cancel" : "stop" }, () => {});
  }
  private async stopped(
    code: number | null,
    signal: string | null,
  ): Promise<void> {
    const slot = this;
    if (slot.releasing && !slot.stopping)
      slot.failure = new Error("Analyzer reset failed.");
    try {
      if (process.platform !== "win32" && slot.workerGroup !== undefined)
        await stopProcessGroup(slot.workerGroup);
      if (slot.windowsJob)
        await (
          await import("./windows-job.js")
        ).stopWindowsJob(slot.windowsJob);
    } catch {
      try {
        slot.windowsJob?.close();
      } catch {
        /* Preserve cleanup failure and best-effort kill-on-close. */
      }
      slot.failure = slot.job
        ? jobFailure(slot.job.request, "cleanup")
        : new Error("Analyzer cleanup failed.");
      slot.cleanupFailure = slot.failure;
      if (slot.session) slot.session.releaseFailure = slot.failure;
    }
    let ownershipLost = false;
    try {
      // A failed native stop/query is not a healthy release. The client must
      // retain its independent group/Job witness for loss-time cleanup even
      // though this retired slot reports a cleanup error to its session.
      if (!slot.cleanupFailure) await slot.releaseOwnership();
    } catch {
      // Actual tree cleanup above is still required even if the client vanished.
      slot.witnessOwner = undefined;
      ownershipLost = true;
    }
    const job = slot.job;
    if (job) {
      let error = slot.failure;
      if (!error && slot.response !== undefined) {
        try {
          const outcome = decodeWorkerResponse(job.request, slot.response);
          if ("error" in outcome) error = outcome.error;
        } catch {
          /* Invalid response remains a failure below. */
        }
      }
      error ??= jobFailure(
        job.request,
        code !== 0 || signal !== null ? "abnormal-exit" : "invalid-response",
        code,
        signal,
      );
      job.complete({ error });
      slot.job = undefined;
    }
    const release = slot.releasing;
    const releaseFailure =
      slot.cleanupFailure ?? (!ownershipLost ? slot.failure : undefined);
    if (release && releaseFailure && slot.session)
      slot.session.releaseFailure = releaseFailure;
    slot.releasing = undefined;
    slot.session = undefined;
    this.onClosed();
    slot.finish();
    if (release) {
      if (releaseFailure) release.reject(releaseFailure);
      else release.resolve();
    }
    this.onAvailable();
  }
  release(): Promise<void> {
    const slot = this;
    if (slot.releasing) return slot.releasing.promise;
    if (slot.stopping) return slot.closed;
    if (!slot.session) return Promise.resolve();
    if (slot.job) {
      this.stop(jobFailure(slot.job.request, "cancellation"), true);
      return slot.closed;
    }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    slot.releasing = { sessionId: slot.session!.id, promise, resolve, reject };
    slot.child!.ref();
    slot.child!.channel?.ref();
    slot.child!.send(
      { version: 1, type: "release", sessionId: slot.session!.id },
      (error) => {
        if (error) this.stop(new Error("Analyzer release failed."));
      },
    );
    return promise;
  }
  async shutdown(): Promise<void> {
    this.stop();
    await this.closed;
    if (this.cleanupFailure) throw this.cleanupFailure;
  }
}
