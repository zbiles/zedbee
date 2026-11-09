import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";
import { expect, test } from "vitest";
import {
  ScanPerformanceRecorder,
  withScanPerformance,
  recordPerformance,
} from "../../src/diagnostics/scan-performance.js";
import { createLocalAnalyzerExecutor } from "../../src/checks/runner/executor.js";
import { runAnalyzerJob } from "../../src/checks/runner/run-job.js";
import { withAnalyzerExecutionSession } from "../../src/checks/runner/session.js";

test("keeps elapsed, queue, and execution separate and source-free", () => {
  const r = new ScanPerformanceRecorder();
  r.record({ checkId: "types", kind: "elapsed", durationMs: 150 });
  r.record({ checkId: "types", kind: "queue", durationMs: 100 });
  r.record({ checkId: "types", kind: "worker", durationMs: 20 });
  expect(r.snapshot().checks).toEqual([
    {
      check_id: "types",
      task_count: 1,
      elapsed_sum_ms: 150,
      elapsed_max_ms: 150,
      queue_sum_ms: 100,
      queue_max_ms: 100,
      worker_sum_ms: 20,
      worker_max_ms: 20,
      cache_hits: 0,
      cache_misses: 0,
      cache_bypasses: 0,
    },
  ]);
});
test("isolates concurrent asynchronous scopes and ignores untrusted identifiers", async () => {
  const a = new ScanPerformanceRecorder(),
    b = new ScanPerformanceRecorder();
  await Promise.all([
    withScanPerformance(a, async () => {
      await Promise.resolve();
      recordPerformance({ checkId: "types", kind: "elapsed", durationMs: 5 });
    }),
    withScanPerformance(b, async () =>
      recordPerformance({ checkId: "lint", kind: "elapsed", durationMs: 7 }),
    ),
  ]);
  a.record({ checkId: "/secret/path", kind: "elapsed", durationMs: 5 });
  expect(a.snapshot().checks.map((x) => x.check_id)).toEqual(["types"]);
  expect(b.snapshot().checks.map((x) => x.check_id)).toEqual(["lint"]);
});
test("real worker execution produces timing without altering its result", async () => {
  const executor = createLocalAnalyzerExecutor({ concurrency: 1 }),
    r = new ScanPerformanceRecorder();
  const session = await executor.openSession();
  try {
    const value = await withScanPerformance(r, () =>
      withAnalyzerExecutionSession(session, () =>
        runAnalyzerJob({
          version: 1,
          checkId: "formatting",
          operation: "format-working-source",
          input: {
            file: "a.js",
            source: "const a=1",
            settings: DEFAULT_FORMATTING_SETTINGS,
          },
        }),
      ),
    );
    expect(value).toContain("const a = 1");
    expect(r.snapshot().checks[0]?.worker_sum_ms).toBeGreaterThan(0);
    expect(r.snapshot().checks[0]?.queue_sum_ms).toBeGreaterThanOrEqual(0);
  } finally {
    await session.close();
    await executor.close();
  }
});

test("queue observer cancellation prevents dispatch to a reused worker", async () => {
  const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
  const session = await executor.openSession();
  const request = {
    version: 1,
    checkId: "formatting",
    operation: "format-working-source",
    input: {
      file: "a.js",
      source: "const a=1",
      settings: DEFAULT_FORMATTING_SETTINGS,
    },
  } as const;
  try {
    await session.run(request);
    const controller = new AbortController();
    await expect(
      session.run(request, {
        signal: controller.signal,
        onTiming: (kind) => {
          if (kind === "queue") controller.abort();
        },
      }),
    ).rejects.toBeDefined();
  } finally {
    await session.close();
    await executor.close();
  }
});
