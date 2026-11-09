import { expect, test } from "vitest";
import { summarizeScanPerformance } from "../../src/telemetry/performance-summary.js";
import { ScanPerformanceRecorder } from "../../src/diagnostics/scan-performance.js";
import { performanceTelemetrySchema } from "../../src/telemetry/schema.js";
test("bounds workspace aggregates and removes unknown failure text", () => {
  const r = new ScanPerformanceRecorder();
  for (let i = 0; i < 1000; i++)
    r.record({ checkId: "types", kind: "elapsed", durationMs: 5 });
  const p = summarizeScanPerformance(r.snapshot(), {
    changedFileCount: 3,
    checks: [
      {
        checkId: "types",
        status: "incomplete",
        error: { code: "/private/project secret", message: "secret" },
      },
    ],
  } as never);
  expect(p.check_performance).toHaveLength(1);
  expect(p.check_performance[0]?.task_count).toBe(1000);
  expect(p.changed_file_count_bucket).toBe("2-5");
  expect(p.incomplete_reasons[0]?.code).toBe("other");
  expect(JSON.stringify(p)).not.toContain("secret");
  expect(performanceTelemetrySchema.safeParse(p).success).toBe(true);
  expect(
    performanceTelemetrySchema.safeParse({ ...p, path: "private" }).success,
  ).toBe(false);
});

test("failed discovery reports an unknown count rather than a large workload", () => {
  expect(
    summarizeScanPerformance(undefined, { changedFileCount: null, checks: [] })
      .changed_file_count_bucket,
  ).toBe("unknown");
});
