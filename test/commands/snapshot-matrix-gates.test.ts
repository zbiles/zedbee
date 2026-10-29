import { expect, it } from "vitest";
import * as gates from "../../bench/snapshot-gates.mjs";

const assess = (value: unknown) =>
  (
    gates as unknown as {
      assessSnapshotMatrixCell(input: unknown): {
        passed: boolean;
        failures: string[];
      };
    }
  ).assessSnapshotMatrixCell(value);
function cell() {
  return {
    samples: 15,
    identities: [
      { root: "base", dirty: "" },
      { root: "head", dirty: "" },
    ],
    results: ["base", "head"].flatMap((root) =>
      Array.from({ length: 15 }, (_, sample) => ({
        root,
        kind: "cli",
        count: 20000,
        scenario: "config",
        sample,
        manifestHash: "a".repeat(64),
        cacheMode: "warm",
        executorMode: "warm-service",
        durationMs: root === "base" ? 1000 : 900,
        observed: { gets: 1, hits: 1, serviceSessions: 1 },
        service: { state: "running" },
        serviceTreeMemory: {
          verified: true,
          samples: 10,
          intervalMs: 100,
          peakRssBytes: 1024,
        },
        decision: {
          outcome: "pass",
          exitCode: 0,
          checks: [{ checkId: "types", status: "completed" }],
        },
      })),
    ),
  };
}
it("accepts a complete paired CLI cell with equal decisions and exercised modes", () => {
  expect(assess(cell()).passed).toBe(true);
});
it("rejects changed report decisions even when the candidate is faster", () => {
  const data = cell();
  data.results.at(-1)!.decision.outcome = "blocked";
  expect(assess(data).failures).toContain("decision-parity");
});
it("rejects mislabeled cache, service and memory samples", () => {
  for (const change of [
    (r: ReturnType<typeof cell>["results"][number]) => {
      r.observed.hits = 0;
    },
    (r: ReturnType<typeof cell>["results"][number]) => {
      r.observed.serviceSessions = 0;
    },
    (r: ReturnType<typeof cell>["results"][number]) => {
      r.serviceTreeMemory.verified = false;
    },
  ]) {
    const data = cell();
    change(data.results.at(-1)!);
    expect(() => assess(data)).toThrow();
  }
});
it("applies both median and p95 time allowances in every cell", () => {
  const data = cell();
  data.results.at(-1)!.durationMs = 1101;
  expect(assess(data).failures).toContain("p95");
  data.results.at(-1)!.durationMs = 1100;
  expect(assess(data).passed).toBe(true);
});
it("rejects missing or duplicated samples, mixed cells and dirty builds", () => {
  const missing = cell();
  missing.results.pop();
  expect(() => assess(missing)).toThrow();
  const duplicate = cell();
  duplicate.results.at(-1)!.sample = 0;
  expect(() => assess(duplicate)).toThrow();
  const mixed = cell();
  mixed.results.at(-1)!.scenario = "json";
  expect(() => assess(mixed)).toThrow();
  const dirty = cell();
  dirty.identities[0]!.dirty = "modified";
  expect(() => assess(dirty)).toThrow();
});
