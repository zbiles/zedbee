import { CHECK_IDS } from "../core/check-ids.js";
import {
  MAX_DIAGNOSTIC_COUNT,
  MAX_DIAGNOSTIC_DURATION_MS,
  SCAN_CHANGE_CATEGORIES,
  SCAN_EXECUTION_MODES,
  SCAN_PERFORMANCE_OVERHEADS,
  SCAN_PERFORMANCE_PHASES,
  SCAN_WORKER_COUNTS,
  type CheckPerformance,
  type ScanPerformanceSummary,
} from "./scan-performance.js";

export interface LocalScanDiagnostics {
  readonly schemaVersion: 1;
  readonly scope: "scan-run";
  readonly swarmVersion: string;
  readonly performance: ScanPerformanceSummary;
}

function record(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError("Invalid local scan diagnostics");
  for (const key of Reflect.ownKeys(value))
    if (
      typeof key !== "string" ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")
    )
      throw new TypeError("Invalid diagnostic fields");
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new TypeError("Invalid diagnostic fields");
}
function duration(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_DIAGNOSTIC_DURATION_MS
  )
    throw new TypeError("Invalid diagnostic duration");
  return value;
}
function count(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_DIAGNOSTIC_COUNT
  )
    throw new TypeError("Invalid diagnostic count");
  return value;
}
function timings(
  value: unknown,
  allowed: readonly string[],
): Record<string, number> {
  const input = record(value);
  keys(input, [], allowed);
  return Object.freeze(
    Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, duration(input[key])]),
    ),
  );
}

/** A source-free local observer boundary. Never copy arbitrary report fields. */
export function sanitizeLocalScanDiagnostics(
  value: unknown,
): LocalScanDiagnostics {
  const input = record(value);
  keys(input, ["schemaVersion", "scope", "swarmVersion", "performance"]);
  if (
    input.schemaVersion !== 1 ||
    input.scope !== "scan-run" ||
    typeof input.swarmVersion !== "string" ||
    input.swarmVersion.length > 64 ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(
      input.swarmVersion,
    )
  )
    throw new TypeError("Invalid scan diagnostic identity");
  const p = record(input.performance);
  keys(
    p,
    ["checks", "partial", "executionMode", "phases", "overhead"],
    ["changeCategory", "workerCount"],
  );
  if (
    typeof p.partial !== "boolean" ||
    !(SCAN_EXECUTION_MODES as readonly string[]).includes(
      p.executionMode as string,
    ) ||
    !Array.isArray(p.checks) ||
    p.checks.length > CHECK_IDS.length ||
    (p.workerCount !== undefined &&
      !(SCAN_WORKER_COUNTS as readonly number[]).includes(
        p.workerCount as number,
      )) ||
    (p.changeCategory !== undefined &&
      !(SCAN_CHANGE_CATEGORIES as readonly string[]).includes(
        p.changeCategory as string,
      ))
  )
    throw new TypeError("Invalid scan diagnostic performance");
  const seen = new Set<string>();
  const checks = p.checks.map((raw) => {
    const row = record(raw);
    const required = [
      "check_id",
      "task_count",
      "elapsed_sum_ms",
      "elapsed_max_ms",
      "cache_hits",
      "cache_misses",
      "cache_bypasses",
    ];
    const optional = [
      "queue_sum_ms",
      "queue_max_ms",
      "worker_sum_ms",
      "worker_max_ms",
    ];
    keys(row, required, optional);
    if (
      typeof row.check_id !== "string" ||
      !(CHECK_IDS as readonly string[]).includes(row.check_id) ||
      seen.has(row.check_id)
    )
      throw new TypeError("Invalid diagnostic check identity");
    seen.add(row.check_id);
    const result: CheckPerformance = {
      check_id: row.check_id as CheckPerformance["check_id"],
      task_count: count(row.task_count),
      elapsed_sum_ms: duration(row.elapsed_sum_ms),
      elapsed_max_ms: duration(row.elapsed_max_ms),
      cache_hits: count(row.cache_hits),
      cache_misses: count(row.cache_misses),
      cache_bypasses: count(row.cache_bypasses),
    };
    for (const key of optional)
      if (Object.hasOwn(row, key))
        Object.assign(result, { [key]: duration(row[key]) });
    return Object.freeze(result);
  });
  return Object.freeze({
    schemaVersion: 1,
    scope: "scan-run",
    swarmVersion: input.swarmVersion,
    performance: Object.freeze({
      checks: Object.freeze(checks) as unknown as CheckPerformance[],
      partial: p.partial,
      executionMode: p.executionMode as ScanPerformanceSummary["executionMode"],
      ...(p.changeCategory === undefined
        ? {}
        : {
            changeCategory: p.changeCategory as NonNullable<
              ScanPerformanceSummary["changeCategory"]
            >,
          }),
      ...(p.workerCount === undefined
        ? {}
        : {
            workerCount: p.workerCount as NonNullable<
              ScanPerformanceSummary["workerCount"]
            >,
          }),
      phases: timings(p.phases, SCAN_PERFORMANCE_PHASES),
      overhead: timings(p.overhead, SCAN_PERFORMANCE_OVERHEADS),
    }),
  });
}

/** Bad optional metrics never replace the canonical scan outcome. */
export function localScanDiagnostics(
  value: unknown,
): LocalScanDiagnostics | undefined {
  try {
    return sanitizeLocalScanDiagnostics(value);
  } catch {
    return undefined;
  }
}
