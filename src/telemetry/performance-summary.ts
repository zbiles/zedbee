import {
  performanceTelemetrySchema,
  INCOMPLETE_CODES,
  TELEMETRY_CHECK_IDS,
  type ScanPerformanceTelemetry,
} from "./schema.js";
import type { ScanPerformanceSummary } from "../diagnostics/scan-performance.js";
import type { ScanReport } from "../scan/report.js";
export function summarizeScanPerformance(
  summary: ScanPerformanceSummary | undefined,
  report: Pick<ScanReport, "checks"> & { changedFileCount?: number | null },
): ScanPerformanceTelemetry {
  const n = report.changedFileCount ?? undefined;
  const bucket =
    n === undefined
      ? "unknown"
      : n === 0
        ? "0"
        : n === 1
          ? "1"
          : n !== undefined && n <= 5
            ? "2-5"
            : n !== undefined && n <= 20
              ? "6-20"
              : n !== undefined && n <= 100
                ? "21-100"
                : "101+";
  const reasons = new Map<
    string,
    {
      check_id: (typeof TELEMETRY_CHECK_IDS)[number] | "zedbee";
      code: (typeof INCOMPLETE_CODES)[number];
      count: number;
    }
  >();
  for (const check of report.checks) {
    if (check.status !== "incomplete") continue;
    const check_id = (TELEMETRY_CHECK_IDS as readonly string[]).includes(
      check.checkId,
    )
      ? (check.checkId as (typeof TELEMETRY_CHECK_IDS)[number])
      : "zedbee";
    const code = (INCOMPLETE_CODES as readonly string[]).includes(
      check.error?.code ?? "",
    )
      ? (check.error!.code as (typeof INCOMPLETE_CODES)[number])
      : "other";
    const key = `${check_id}:${code}`,
      row = reasons.get(key) ?? { check_id, code, count: 0 };
    row.count = Math.min(1000000, row.count + 1);
    reasons.set(key, row);
  }
  return performanceTelemetrySchema.parse({
    performance_version: 1,
    performance_status: summary
      ? summary.partial
        ? "partial"
        : "complete"
      : "unavailable",
    changed_file_count_bucket: bucket,
    change_category: summary?.changeCategory ?? "unknown",
    execution_mode: summary?.executionMode ?? "unknown",
    ...(summary?.workerCount === undefined
      ? {}
      : { worker_count: summary.workerCount }),
    check_performance: summary?.checks ?? [],
    incomplete_reasons: [...reasons.values()].slice(0, 26),
    incomplete_reasons_omitted: Math.max(0, reasons.size - 26),
  });
}
