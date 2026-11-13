import { AsyncLocalStorage } from "node:async_hooks";
import { TELEMETRY_CHECK_IDS } from "../telemetry/schema.js";
export type PerformanceKind =
  | "dispatcher"
  | "result"
  | "elapsed"
  | "queue"
  | "worker"
  | "cache_hit"
  | "cache_miss"
  | "cache_bypass"
  | "cache_lookup"
  | "cache_prepare"
  | "service";
export interface PerformanceSample {
  checkId: string;
  kind: PerformanceKind;
  durationMs: number;
}
export interface CheckPerformance {
  check_id: (typeof TELEMETRY_CHECK_IDS)[number];
  task_count: number;
  elapsed_sum_ms: number;
  elapsed_max_ms: number;
  queue_sum_ms?: number;
  queue_max_ms?: number;
  worker_sum_ms?: number;
  worker_max_ms?: number;
  cache_hits: number;
  cache_misses: number;
  cache_bypasses: number;
}
export interface ScanPerformanceSummary {
  checks: CheckPerformance[];
  partial: boolean;
  executionMode: "local" | "service" | "none" | "unknown";
  changeCategory?:
    | "non_source"
    | "source"
    | "configuration_or_dependency"
    | "mixed"
    | "unknown";
  workerCount?: 1 | 2 | 4;
  phases: Record<string, number>;
  overhead: Record<string, number>;
}
const active = new AsyncLocalStorage<ScanPerformanceRecorder>();
const bounded = (v: number) => Math.min(604800000, Math.max(0, Math.round(v)));
export class ScanPerformanceRecorder {
  private readonly checks = new Map<string, CheckPerformance>();
  private partial = false;
  markPartial(): void {
    this.partial = true;
  }
  private changeCategory: ScanPerformanceSummary["changeCategory"];
  category(reason: string): void {
    const next =
      reason === "unrelated"
        ? "non_source"
        : reason === "source"
          ? "source"
          : ["configuration", "dependency", "data"].includes(reason)
            ? "configuration_or_dependency"
            : "unknown";
    this.changeCategory =
      this.changeCategory === undefined
        ? next
        : this.changeCategory === next
          ? next
          : "mixed";
  }
  private executionMode: ScanPerformanceSummary["executionMode"] = "none";
  private workerCount: 1 | 2 | 4 | undefined;
  private phases: Record<string, number> = {};
  private overhead: Record<string, number> = {};
  mode(mode: "local" | "service", workers?: 1 | 2 | 4): void {
    this.executionMode = mode;
    this.workerCount = workers;
  }
  phase(name: string, duration: number): void {
    if (
      [
        "configuration",
        "baseline-resolution",
        "change-discovery",
        "snapshot-construction",
        "baseline-inspection",
        "target-inspection",
        "project-inspection",
        "source-capture",
        "dispatch",
        "policy-evaluation",
        "cleanup",
      ].includes(name)
    )
      this.phases[name] = bounded((this.phases[name] ?? 0) + duration);
  }
  record(sample: PerformanceSample): void {
    if (
      !(TELEMETRY_CHECK_IDS as readonly string[]).includes(sample.checkId) ||
      !Number.isFinite(sample.durationMs) ||
      sample.durationMs < 0
    ) {
      this.partial = true;
      return;
    }
    let row = this.checks.get(sample.checkId);
    if (!row) {
      row = {
        check_id: sample.checkId as CheckPerformance["check_id"],
        task_count: 0,
        elapsed_sum_ms: 0,
        elapsed_max_ms: 0,
        cache_hits: 0,
        cache_misses: 0,
        cache_bypasses: 0,
      };
      this.checks.set(sample.checkId, row);
    }
    if (sample.durationMs > 604800000) this.partial = true;
    const ms = bounded(sample.durationMs);
    if (
      [
        "cache_lookup",
        "cache_prepare",
        "service",
        "dispatcher",
        "result",
      ].includes(sample.kind)
    ) {
      this.overhead[sample.kind] = bounded(
        (this.overhead[sample.kind] ?? 0) + ms,
      );
      return;
    }
    if (sample.kind === "elapsed") {
      row.task_count = Math.min(1000000, row.task_count + 1);
      row.elapsed_sum_ms = bounded(row.elapsed_sum_ms + ms);
      row.elapsed_max_ms = Math.max(row.elapsed_max_ms, ms);
    } else if (sample.kind === "queue" || sample.kind === "worker") {
      const sum = `${sample.kind}_sum_ms` as const,
        max = `${sample.kind}_max_ms` as const;
      row[sum] = bounded((row[sum] ?? 0) + ms);
      row[max] = Math.max(row[max] ?? 0, ms);
    } else if (
      ["cache_hit", "cache_miss", "cache_bypass"].includes(sample.kind)
    ) {
      const key =
        sample.kind === "cache_hit"
          ? "cache_hits"
          : sample.kind === "cache_miss"
            ? "cache_misses"
            : "cache_bypasses";
      row[key] = Math.min(1000000, row[key] + 1);
    }
  }
  snapshot(): ScanPerformanceSummary {
    return {
      checks: [...this.checks.values()]
        .sort((a, b) => a.check_id.localeCompare(b.check_id))
        .map((x) => ({ ...x })),
      partial: this.partial,
      executionMode: this.executionMode,
      ...(this.changeCategory === undefined
        ? {}
        : { changeCategory: this.changeCategory }),
      ...(this.workerCount === undefined
        ? {}
        : { workerCount: this.workerCount }),
      phases: { ...this.phases },
      overhead: { ...this.overhead },
    };
  }
}
export function withScanPerformance<T>(
  recorder: ScanPerformanceRecorder,
  run: () => Promise<T>,
): Promise<T> {
  return active.run(recorder, run);
}
export function recordPerformance(sample: PerformanceSample): void {
  try {
    active.getStore()?.record(sample);
  } catch {}
}
export function performanceObserver(
  checkId: string,
):
  | ((kind: "queue" | "worker" | "result", durationMs: number) => void)
  | undefined {
  const recorder = active.getStore();
  if (!recorder) return undefined;
  return (kind, durationMs) => {
    try {
      recorder.record({ checkId, kind, durationMs });
    } catch {}
  };
}

export function recordExecutionMode(
  mode: "local" | "service",
  workers?: 1 | 2 | 4,
): void {
  try {
    active.getStore()?.mode(mode, workers);
  } catch {}
}

export function recordChangeCategory(reason: string): void {
  try {
    active.getStore()?.category(reason);
  } catch {}
}
