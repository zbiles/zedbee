import { expect, it } from "vitest";
import { sanitizeLocalScanDiagnostics } from "../../src/diagnostics/local-scan-diagnostics.js";
import { ScanPerformanceRecorder } from "../../src/diagnostics/scan-performance.js";
import { ZEDBEE_VERSION } from "../../src/core/package-version.js";
import { renderJson } from "../../src/renderers/json.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createReport } from "../helpers/scan-report.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { CHECK_IDS } from "../../src/config/schema.js";

function sample() {
  const recorder = new ScanPerformanceRecorder();
  recorder.record({ checkId: "types", kind: "elapsed", durationMs: 150 });
  recorder.record({ checkId: "types", kind: "queue", durationMs: 100 });
  recorder.record({ checkId: "types", kind: "worker", durationMs: 20 });
  return {
    schemaVersion: 1 as const,
    scope: "scan-run" as const,
    swarmVersion: ZEDBEE_VERSION,
    performance: recorder.snapshot(),
  };
}

it("preserves separately measured elapsed, queue and worker wall time", () => {
  const value = sanitizeLocalScanDiagnostics(sample());
  expect(value.performance.checks[0]).toMatchObject({
    elapsed_sum_ms: 150,
    queue_sum_ms: 100,
    worker_sum_ms: 20,
  });
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.performance.checks)).toBe(true);
  expect(
    JSON.parse(renderJson(createReport({ diagnostics: value }))),
  ).toHaveProperty("diagnostics", value);
  expect(JSON.parse(renderJson(createReport()))).not.toHaveProperty(
    "diagnostics",
  );
});

it.each([
  (v: ReturnType<typeof sample>) => ({ ...v, source: "private-marker" }),
  (v: ReturnType<typeof sample>) => ({ ...v, scope: "full-command" }),
  (v: ReturnType<typeof sample>) => ({
    ...v,
    swarmVersion: "/private-marker",
  }),
  (v: ReturnType<typeof sample>) => ({
    ...v,
    performance: { ...v.performance, target: "private-marker" },
  }),
  (v: ReturnType<typeof sample>) => ({
    ...v,
    performance: {
      ...v.performance,
      checks: [{ ...v.performance.checks[0], check_id: "private-marker" }],
    },
  }),
  (v: ReturnType<typeof sample>) => ({
    ...v,
    performance: {
      ...v.performance,
      checks: [{ ...v.performance.checks[0], queue_sum_ms: Infinity }],
    },
  }),
  (v: ReturnType<typeof sample>) => ({
    ...v,
    performance: {
      ...v.performance,
      checks: [{ ...v.performance.checks[0], cache_hits: 1_000_001 }],
    },
  }),
  (v: ReturnType<typeof sample>) => ({
    ...v,
    performance: { ...v.performance, workerCount: 3 },
  }),
  (v: ReturnType<typeof sample>) => ({
    ...v,
    performance: { ...v.performance, phases: { "/private-marker": 1 } },
  }),
  (v: ReturnType<typeof sample>) => ({
    ...v,
    performance: { ...v.performance, overhead: { service: 604_800_001 } },
  }),
  (v: ReturnType<typeof sample>) => ({
    ...v,
    performance: {
      ...v.performance,
      checks: [...v.performance.checks, ...v.performance.checks],
    },
  }),
])("rejects malformed or source-bearing local metadata", (change) => {
  const invalid = change(sample());
  expect(() => sanitizeLocalScanDiagnostics(invalid)).toThrow();
  const exported = renderJson(
    createReport({ diagnostics: invalid as never }),
  );
  expect(exported).not.toContain("private-marker");
  expect(JSON.parse(exported)).not.toHaveProperty("diagnostics");
});

it("preserves absent measurements and partial status without inventing zero execution", () => {
  const recorder = new ScanPerformanceRecorder();
  recorder.markPartial();
  const value = sanitizeLocalScanDiagnostics({
    ...sample(),
    performance: recorder.snapshot(),
  });
  expect(value.performance.partial).toBe(true);
  expect(value.performance.executionMode).toBe("none");
  expect(value.performance.checks).toEqual([]);
  expect(value.performance).not.toHaveProperty("workerCount");
});

it.each(["contextual", "source-free"] as const)(
  "attaches runtime diagnostics without a telemetry observer in %s mode",
  async (diagnosticMessages) => {
    const repo = await createGitRepository();
    await repo.write("package.json", '{"name":"fixture"}');
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: Object.fromEntries(CHECK_IDS.map((id) => [id, "off"])),
      }),
    );
    await repo.commitAll("baseline");
    await repo.write("notes.md", "private-source-marker");
    await repo.git(["add", "notes.md"]);
    const report = await runScan({
      repositoryRoot: repo.root,
      diagnosticMessages,
      cache: false,
    });
    expect(report.outcome).toBe("pass");
    expect(report.diagnostics).toMatchObject({
      schemaVersion: 1,
      scope: "scan-run",
      swarmVersion: ZEDBEE_VERSION,
      performance: { partial: false, executionMode: "none", checks: [] },
    });
    expect(JSON.stringify(report.diagnostics)).not.toContain(
      "private-source-marker",
    );
    const observed = await runScan({
      repositoryRoot: repo.root,
      cache: false,
      onPerformanceSummary() {
        throw Error("observer-marker");
      },
    });
    expect(observed.outcome).toBe("pass");
    expect(observed.diagnostics).toBeDefined();
  },
);

it("marks an aborted scan's observer data partial without inventing a completed report", async () => {
  let summary: unknown;
  await expect(
    runScan({
      repositoryRoot: "/unused",
      cache: false,
      signal: AbortSignal.abort(),
      onPerformanceSummary: (value) => {
        summary = value;
      },
    }),
  ).rejects.toBeDefined();
  expect(summary).toMatchObject({
    partial: true,
    executionMode: "none",
    checks: [],
  });
});

it("marks an incomplete configuration scan partial and keeps diagnostic metadata safe", async () => {
  const repo = await createGitRepository();
  await repo.write("package.json", '{"name":"fixture"}');
  await repo.commitAll("baseline");
  await repo.write(".zedbeerc.jsonc", '{ "private-source-marker":');
  await repo.git(["add", ".zedbeerc.jsonc"]);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome).toBe("incomplete");
  expect(report.diagnostics?.performance.partial).toBe(true);
  expect(JSON.stringify(report.diagnostics)).not.toContain(
    "private-source-marker",
  );
});
