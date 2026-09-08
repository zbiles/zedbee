import { randomUUID } from "node:crypto";
import { executionClassFor } from "../applicability.js";
import {
  validateAnalyzerRequest,
  type AnalyzerRequest,
  type AnalyzerResult,
} from "./protocol.js";
import {
  AnalyzerCapacityError,
  analyzerRequestRetentionBytes,
  exactFields,
  jobFailure,
} from "./envelope.js";
export { AnalyzerCapacityError } from "./envelope.js";
import {
  SupervisedWorkerSlot,
  defaultWorkerEntry,
  type WorkerJob,
  type WorkerOutcome,
  type AnalyzerTreeWitness,
  type WorkerOwnershipHooks,
} from "./worker-slot.js";
export type { AnalyzerTreeWitness } from "./worker-slot.js";
import type { AnalyzerJobOptions } from "./run-job.js";
import {
  captureAnalysisSources,
  exportAnalysisSourceCapture,
  type AnalysisSourceCapture,
  type AnalysisSourceCaptureTransport,
  type AnalysisSourceSelection,
} from "../../inspection/source-capture.js";

export interface AnalyzerExecutionSession {
  run<R extends AnalyzerRequest>(
    request: R,
    options?: AnalyzerJobOptions,
  ): Promise<AnalyzerResult<R>>;
  close(): Promise<void>;
}
export interface AnalyzerExecutionSessionOptions {
  readonly sourceSelections?: readonly AnalysisSourceSelection[];
}
export interface AnalyzerExecutor {
  openSession(
    options?: AnalyzerExecutionSessionOptions,
  ): Promise<AnalyzerExecutionSession>;
  close(): Promise<void>;
}
/** Internal owner handoff only; never a worker/config/service request field. */
export interface AnalyzerOwnershipHooks {
  acquire(
    session: AnalyzerExecutionSession,
    witness: AnalyzerTreeWitness,
  ): Promise<void>;
  release(
    session: AnalyzerExecutionSession,
    witness: AnalyzerTreeWitness,
  ): Promise<void>;
}
type Outcome = WorkerOutcome;
interface Job extends WorkerJob {
  readonly session: Session;
  readonly request: AnalyzerRequest;
  readonly options: AnalyzerJobOptions;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly retainedBytes: number;
  cancel?: () => void;
  provisional?: Outcome | undefined;
}
function affinity(request: AnalyzerRequest): string {
  return [
    "lint",
    "reactCorrectness",
    "reactAccessibility",
    "cyclomaticComplexity",
    "readabilityComplexity",
    "types",
  ].includes(request.checkId)
    ? "syntax"
    : request.checkId;
}
class Session implements AnalyzerExecutionSession {
  readonly id = randomUUID();
  closed = false;
  closing?: Promise<void>;
  capture?: AnalysisSourceCapture | undefined;
  transport?: AnalysisSourceCaptureTransport | undefined;
  releaseFailure?: Error;
  readonly ownership: WorkerOwnershipHooks | undefined;
  constructor(readonly owner: LocalExecutor) {
    this.ownership = owner.ownership
      ? {
          acquire: (witness) => owner.ownership!.acquire(this, witness),
          release: (witness) => owner.ownership!.release(this, witness),
        }
      : undefined;
  }
  async run<R extends AnalyzerRequest>(
    request: R,
    options: AnalyzerJobOptions = {},
  ): Promise<AnalyzerResult<R>> {
    if (this.closed) throw new Error("Analyzer session is closed.");
    return this.owner.enqueue(this, request, options) as Promise<
      AnalyzerResult<R>
    >;
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.owner.releaseSession(this);
    }
    return this.closing;
  }
}
class LocalExecutor implements AnalyzerExecutor {
  readonly sessions = new Set<Session>();
  readonly slots = new Set<SupervisedWorkerSlot>();
  readonly queue: Job[] = [];
  readonly opening = new Set<Promise<void>>();
  closed = false;
  pumping = false;
  captureReservations = 0;
  acceptedJobs = 0;
  acceptedBytes = 0;
  closing?: Promise<void>;
  constructor(
    readonly concurrency: 1 | 2 | 4,
    readonly ownership?: AnalyzerOwnershipHooks,
  ) {}
  async openSession(
    options: AnalyzerExecutionSessionOptions = {},
  ): Promise<AnalyzerExecutionSession> {
    if (this.closed) throw new Error("Analyzer executor is closed.");
    if (this.sessions.size >= 32) throw new AnalyzerCapacityError("session");
    if (!exactFields(options, ["sourceSelections"]))
      throw new TypeError("Invalid analyzer session options.");
    if (
      options.sourceSelections !== undefined &&
      (!Array.isArray(options.sourceSelections) ||
        options.sourceSelections.some(
          (selection) =>
            !exactFields(selection, ["snapshotRoot", "paths"]) ||
            typeof selection.snapshotRoot !== "string" ||
            !Array.isArray(selection.paths) ||
            selection.paths.some((path: unknown) => typeof path !== "string"),
        ))
    )
      throw new TypeError("Invalid analyzer source selections.");
    const session = new Session(this);
    this.sessions.add(session);
    let finishOpening!: () => void;
    const opening = new Promise<void>((resolve) => {
      finishOpening = resolve;
    });
    this.opening.add(opening);
    try {
      // Parent captures reserve 128 MiB each for source, metadata and staging.
      // Slots add 384 MiB parser + 128 MiB capture estimates. These limits cover
      // retained data, not engine RSS or currently executing engine allocations.
      if (
        options.sourceSelections !== undefined &&
        this.captureReservations < this.concurrency
      ) {
        this.captureReservations++;
        try {
          session.capture = await captureAnalysisSources(
            options.sourceSelections as readonly AnalysisSourceSelection[],
          );
          if (session.capture)
            session.transport = exportAnalysisSourceCapture(session.capture);
          if (!session.transport) {
            await session.capture?.close();
            session.capture = undefined;
          }
        } finally {
          if (!session.capture) this.captureReservations--;
        }
      }
      if (this.closed || session.closed)
        throw new Error("Analyzer executor is closed.");
      return session;
    } catch (error) {
      await session.close();
      throw error;
    } finally {
      this.opening.delete(opening);
      finishOpening();
    }
  }
  enqueue(
    session: Session,
    request: AnalyzerRequest,
    options: AnalyzerJobOptions,
  ): Promise<unknown> {
    if (this.closed || session.closed)
      return Promise.reject(new Error("Analyzer session is closed."));
    if (options.signal?.aborted)
      return Promise.reject(jobFailure(request, "cancellation"));
    if (this.acceptedJobs >= 64)
      return Promise.reject(new AnalyzerCapacityError("job"));
    let retainedBytes: number;
    try {
      retainedBytes = analyzerRequestRetentionBytes(request);
      if (this.acceptedBytes + retainedBytes > 64 * 1024 * 1024)
        throw new AnalyzerCapacityError("request");
      request = structuredClone(request);
      validateAnalyzerRequest(request);
    } catch (error) {
      return Promise.reject(
        error instanceof AnalyzerCapacityError
          ? error
          : new TypeError("Invalid analyzer request"),
      );
    }
    this.acceptedJobs++;
    this.acceptedBytes += retainedBytes;
    return new Promise((resolve, reject) => {
      const job: Job = {
        session,
        sessionId: session.id,
        jobId: randomUUID(),
        request,
        options,
        resolve,
        reject,
        retainedBytes,
        complete: (outcome) => this.settle(job, outcome),
      };
      job.cancel = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) {
          this.queue.splice(index, 1);
          this.settle(job, { error: jobFailure(request, "cancellation") });
        } else {
          const slot = [...this.slots].find((slot) => slot.job === job);
          if (slot) slot.stop(jobFailure(request, "cancellation"), true);
        }
        this.pump();
      };
      options.signal?.addEventListener("abort", job.cancel, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }
  settle(job: Job, outcome: Outcome): void {
    this.acceptedJobs--;
    this.acceptedBytes -= job.retainedBytes;
    if (job.cancel)
      job.options.signal?.removeEventListener("abort", job.cancel);
    job.provisional = undefined;
    if ("error" in outcome) job.reject(outcome.error);
    else job.resolve(outcome.result);
  }
  pump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    void (async () => {
      try {
        while (!this.closed) {
          const networkBusy = [...this.slots].some(
            (slot) =>
              slot.job &&
              executionClassFor(slot.job.request.checkId) === "network",
          );
          const index = this.queue.findIndex(
            (job) =>
              !networkBusy ||
              executionClassFor(job.request.checkId) !== "network",
          );
          if (index < 0) break;
          const job = this.queue[index]!;
          const entry = job.options.workerEntry ?? defaultWorkerEntry;
          const idle = [...this.slots].filter(
            (slot) => !slot.job && !slot.releasing && !slot.stopping,
          );
          let slot =
            idle.find(
              (slot) =>
                slot.entry === entry &&
                slot.session === job.session &&
                slot.affinity === affinity(job.request),
            ) ??
            idle.find(
              (slot) => slot.entry === entry && slot.session === job.session,
            ) ??
            idle.find(
              (slot) =>
                slot.entry === entry &&
                slot.session === undefined &&
                slot.affinity === affinity(job.request),
            ) ??
            idle.find(
              (slot) => slot.entry === entry && slot.session === undefined,
            );
          if (!slot && this.slots.size < this.concurrency)
            slot = this.newSlot(entry);
          if (!slot) {
            const victim = idle[0];
            if (!victim) break;
            if (victim.entry !== entry) {
              victim.stop();
              await victim.closed;
            } else {
              try {
                await victim.release();
              } catch {
                /* The released session records reset failure; this queued job has not started. */
              }
            }
            continue;
          }
          this.queue.splice(index, 1);
          if (job.options.signal?.aborted || job.session.closed) {
            this.settle(job, {
              error: jobFailure(job.request, "cancellation"),
            });
            continue;
          }
          slot.job = job;
          slot.affinity = affinity(job.request);
          const binding = slot.session === undefined;
          slot.session = job.session;
          const envelope = {
            version: 1,
            type: "job",
            sessionId: job.sessionId,
            jobId: job.jobId,
            request: job.request,
            ...(binding && job.session.transport
              ? { capture: job.session.transport }
              : {}),
          };
          await slot.dispatch(envelope);
        }
      } finally {
        this.pumping = false;
      }
    })().catch((error) => {
      for (const job of this.queue.splice(0))
        this.settle(job, {
          error:
            error instanceof Error
              ? error
              : new Error("Analyzer scheduling failed."),
        });
    });
  }
  newSlot(entry: string): SupervisedWorkerSlot {
    const slot = new SupervisedWorkerSlot(
      entry,
      () => {
        this.slots.delete(slot);
      },
      () => this.pump(),
    );
    this.slots.add(slot);
    return slot;
  }
  async releaseSession(session: Session): Promise<void> {
    for (const job of [...this.queue])
      if (job.session === session) {
        this.queue.splice(this.queue.indexOf(job), 1);
        this.settle(job, { error: jobFailure(job.request, "cancellation") });
      }
    const outcomes = await Promise.allSettled(
      [...this.slots]
        .filter((slot) => slot.session === session)
        .map((slot) => slot.release()),
    );
    session.transport = undefined;
    if (session.capture) {
      await session.capture.close();
      session.capture = undefined;
      this.captureReservations--;
    }
    this.sessions.delete(session);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (session.releaseFailure) throw session.releaseFailure;
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = (async () => {
        await Promise.all(this.opening);
        const sessions = await Promise.allSettled(
          [...this.sessions].map((session) => session.close()),
        );
        const slots = [...this.slots];
        const stopped = await Promise.allSettled(
          slots.map((slot) => slot.shutdown()),
        );
        const failure =
          sessions.find((outcome) => outcome.status === "rejected") ??
          stopped.find((outcome) => outcome.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
    }
    return this.closing;
  }
}
export function createLocalAnalyzerExecutor(
  options: { concurrency?: 1 | 2 | 4; ownership?: AnalyzerOwnershipHooks } = {},
): AnalyzerExecutor {
  if (
    !exactFields(options, ["concurrency", "ownership"]) ||
    ![1, 2, 4].includes(options.concurrency ?? 2)
  )
    throw new TypeError("Invalid analyzer executor options.");
  if (
    options.ownership !== undefined &&
    (typeof options.ownership.acquire !== "function" ||
      typeof options.ownership.release !== "function")
  )
    throw new TypeError("Invalid analyzer ownership hooks.");
  return new LocalExecutor(options.concurrency ?? 2, options.ownership);
}
