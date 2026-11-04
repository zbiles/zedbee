import { describe, expect, it, vi } from "vitest";
import { collectComplexityObservations } from "../../../src/checks/complexity/adapter.js";
import { collectMetricEntitySpans } from "../../../src/attribution/entities.js";
import { pairClassMetricObservations } from "../../../src/checks/complexity/pair-class-metrics.js";
import type { Observation } from "../../../src/core/types.js";

const work = vi.hoisted(() => ({ offsets: 0 }));
vi.mock("../../../src/attribution/entities.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/attribution/entities.js")
    >();
  return {
    ...actual,
    collectMetricEntitySpans: (
      ...args: Parameters<typeof actual.collectMetricEntitySpans>
    ) =>
      actual.collectMetricEntitySpans(...args).map((span) => ({
        entity: span.entity,
        get startOffset() {
          work.offsets++;
          return span.startOffset;
        },
        get endOffset() {
          work.offsets++;
          return span.endOffset;
        },
      })),
  };
});

describe("complexity matching work", () => {
  it("matches many function metrics without rescanning every syntax span", async () => {
    const source = Array.from(
      { length: 200 },
      (_, index) =>
        `function item${index}(flag: boolean) { if (flag) return 1; return 0; }`,
    ).join("\n");
    work.offsets = 0;
    const observations = await collectComplexityObservations(
      "src/many.ts",
      source,
    );
    expect(observations).toHaveLength(400);
    expect(
      observations.filter(({ metric }) => metric?.value === 2),
    ).toHaveLength(200);
    expect(new Set(observations.map(({ entity }) => entity?.name)).size).toBe(
      200,
    );
    expect(work.offsets).toBeLessThan(20_000);
  });

  it("groups class source anchors instead of filtering every sibling per member", () => {
    const file = "src/classes.ts";
    const before = Array.from(
      { length: 200 },
      (_, index) => `consume(class { run() { return ${index}; } });`,
    ).join("\n");
    const after = `const unrelated = 0;\n${before}`;
    const metrics = (source: string): readonly Observation[] =>
      collectMetricEntitySpans(source, file).map(({ entity }) => ({
        check: "cyclomaticComplexity",
        rule: "cyclomatic-complexity",
        identity: entity.identity,
        severity: "error",
        message: "Cyclomatic complexity metric.",
        entity,
        metric: { name: "cyclomatic-complexity", value: 1 },
      }));
    const baseline = metrics(before);
    const target = metrics(after);
    const filter = vi.spyOn(Array.prototype, "filter");
    let inspectedMembers = 0;
    let result: ReturnType<typeof pairClassMetricObservations>;
    try {
      result = pairClassMetricObservations(
        { observations: baseline, files: { [file]: before } },
        { observations: target, files: { [file]: after } },
        {
          files: new Map([
            [
              file,
              {
                path: file,
                status: "modified",
                addedRanges: [{ start: 1, end: 1 }],
              },
            ],
          ]),
          isEmpty: false,
          containsAddedLine: (_file, line) => line === 1,
        },
      );
      for (const context of filter.mock.contexts) {
        if (
          Array.isArray(context) &&
          context.length > 0 &&
          typeof context[0] === "object" &&
          context[0] !== null &&
          "sourceKey" in context[0]
        )
          inspectedMembers += context.length;
      }
    } finally {
      filter.mockRestore();
    }
    expect(
      result!.baselineObservations.map(({ identity }) => identity),
    ).toEqual(target.map(({ identity }) => identity));
    expect(inspectedMembers).toBeLessThan(2_000);
  });
});
