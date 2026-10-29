import { expect, it } from "vitest";
import { assessSnapshotPreparation } from "../../bench/snapshot-gates.mjs";

function report(
  target: { snapshots?: number; total?: number; rss?: number } = {},
) {
  return {
    samples: 15,
    identities: [
      { root: "base", dirty: "" },
      { root: "head", dirty: "" },
    ],
    results: ["base", "head"].flatMap((root) =>
      Array.from({ length: 15 }, (_, sample) => ({
        root,
        kind: "preparation",
        count: 4000,
        scenario: "json",
        sample,
        manifestHash: "a".repeat(64),
        timings: {
          snapshots: root === "base" ? 2000 : (target.snapshots ?? 1400),
          total: root === "base" ? 4000 : (target.total ?? 3400),
        },
        peakRssBytes:
          root === "base"
            ? 256 * 1024 * 1024
            : (target.rss ?? 260 * 1024 * 1024),
      })),
    ),
  };
}

it("accepts measured speedup within the time and memory budgets", () => {
  expect(assessSnapshotPreparation(report()).passed).toBe(true);
});
it("rejects fast snapshots that exceed the peak memory allowance", () => {
  const result = assessSnapshotPreparation(report({ rss: 273 * 1024 * 1024 }));
  expect(result.passed).toBe(false);
  expect(result.failures).toContain("peak-memory");
});
it("requires a 25 percent median snapshot improvement", () => {
  expect(
    assessSnapshotPreparation(report({ snapshots: 1501 })).failures,
  ).toContain("snapshot-speed");
  expect(assessSnapshotPreparation(report({ snapshots: 1500 })).passed).toBe(
    true,
  );
});
it("applies both absolute and relative total-time regression thresholds", () => {
  expect(assessSnapshotPreparation(report({ total: 4400 })).passed).toBe(true);
  expect(assessSnapshotPreparation(report({ total: 4401 })).failures).toContain(
    "preparation-median",
  );
});
it("catches p95 regression even when the median improves", () => {
  const artifact = report();
  artifact.results.at(-1)!.timings.total = 5000;
  expect(assessSnapshotPreparation(artifact).failures).toContain(
    "preparation-p95",
  );
});
it("refuses missing samples, changed fixtures and dirty builds", () => {
  const missing = report();
  missing.results.pop();
  expect(() => assessSnapshotPreparation(missing)).toThrow();
  const changed = report();
  changed.results.at(-1)!.manifestHash = "b".repeat(64);
  expect(() => assessSnapshotPreparation(changed)).toThrow();
  const dirty = report();
  dirty.identities[1]!.dirty = "modified source";
  expect(() => assessSnapshotPreparation(dirty)).toThrow();
});
