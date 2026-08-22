import { describe, expect, it } from "vitest";
import { attributeMetricDelta } from "../../src/attribution/metrics.js";
import type { ChangedEntity, Observation } from "../../src/core/types.js";

const entity: ChangedEntity = {
  kind: "function",
  name: "parseOrder",
  file: "src/parser.ts",
  startLine: 1,
  endLine: 8,
  identity: "function:src/parser.ts:parseOrder",
};

function metric(value: number): Observation {
  return {
    check: "complexity",
    rule: "cyclomatic-complexity",
    identity: entity.identity,
    severity: "error",
    message: "Complexity exceeds policy.",
    entity,
    metric: { name: "cyclomatic-complexity", value },
  };
}

describe("attributeMetricDelta", () => {
  it("stages a worsening metric on an exactly changed entity", () => {
    const finding = attributeMetricDelta(metric(25), metric(26), [entity], {
      limit: 20,
      blockWorsening: true,
    });

    expect(finding.attribution).toEqual({
      kind: "metric-delta",
      staged: true,
      evidence: [
        "baseline-value:25",
        "entity:function:src/parser.ts:parseOrder",
        "limit:20",
        "reason:worsening-above-limit",
        "target-value:26",
      ],
    });
    expect(finding.location).toEqual({ file: "src/parser.ts" });
  });

  it("does not stage an unchanged, decreased, or unrelated metric", () => {
    const policy = { limit: 20, blockWorsening: true } as const;
    expect(
      attributeMetricDelta(metric(25), metric(25), [entity], policy).attribution
        .staged,
    ).toBe(false);
    expect(
      attributeMetricDelta(metric(25), metric(24), [entity], policy).attribution
        .staged,
    ).toBe(false);
    expect(
      attributeMetricDelta(metric(25), metric(26), [], policy).attribution
        .staged,
    ).toBe(false);
  });

  it("stages a limit crossing and a target-only value above the limit", () => {
    const policy = { limit: 20, blockWorsening: true } as const;
    expect(
      attributeMetricDelta(metric(20), metric(21), [entity], policy).attribution
        .evidence,
    ).toContain("reason:limit-crossing");
    expect(
      attributeMetricDelta(undefined, metric(21), [entity], policy).attribution
        .evidence,
    ).toContain("reason:target-only-above-limit");
    expect(
      attributeMetricDelta(undefined, metric(20), [entity], policy).attribution
        .staged,
    ).toBe(false);
  });

  it("does not stage already-over-limit worsening when policy permits it", () => {
    expect(
      attributeMetricDelta(metric(25), metric(26), [entity], {
        limit: 20,
        blockWorsening: false,
      }).attribution.staged,
    ).toBe(false);
  });

  it("treats a deleted baseline entity as non-blocking", () => {
    expect(
      attributeMetricDelta(metric(25), undefined, [entity], {
        limit: 20,
        blockWorsening: true,
      }),
    ).toBeUndefined();
  });

  it("requires the exact changed entity fields and matching fingerprints", () => {
    const wrongEntity = {
      ...entity,
      name: "someOtherFunction",
      identity: "function:src/parser.ts:someOtherFunction",
    };
    expect(
      attributeMetricDelta(metric(25), metric(26), [wrongEntity], {
        limit: 20,
        blockWorsening: true,
      }).attribution.staged,
    ).toBe(false);

    expect(() =>
      attributeMetricDelta(
        metric(25),
        { ...metric(26), rule: "other-metric-rule" },
        [entity],
        {
          limit: 20,
          blockWorsening: true,
        },
      ),
    ).toThrow(TypeError);
  });

  it("requires the exact member-role identity when public entity fields match", () => {
    const changedGetter: ChangedEntity = {
      kind: "method",
      name: "value",
      file: "src/accessor.ts",
      startLine: 2,
      endLine: 2,
      identity:
        "method:src/accessor.ts:class=Accessor/member-scope=instance/member-role=get/method=value",
    };
    const setterObservation: Observation = {
      ...metric(26),
      identity:
        "method:src/accessor.ts:class=Accessor/member-scope=instance/member-role=set/method=value",
      entity: {
        kind: "method",
        name: "value",
        file: "src/accessor.ts",
      },
    };

    expect(
      attributeMetricDelta(undefined, setterObservation, [changedGetter], {
        limit: 20,
        blockWorsening: true,
      }).attribution.staged,
    ).toBe(false);
  });

  it("snapshots untrusted observations once and emits no source evidence", () => {
    let identityReads = 0;
    const target = Object.defineProperties(metric(26), {
      identity: {
        enumerable: true,
        get() {
          identityReads += 1;
          return entity.identity;
        },
      },
      sourceText: {
        enumerable: true,
        get() {
          throw new Error("unknown source field must not be read");
        },
      },
    });
    const finding = attributeMetricDelta(metric(25), target, [entity], {
      limit: 20,
      blockWorsening: true,
    });

    expect(identityReads).toBe(1);
    expect(finding.attribution.evidence.join(" ")).not.toContain("source");
    expect(Object.isFrozen(finding)).toBe(true);
    expect(Object.isFrozen(finding.attribution.evidence)).toBe(true);
  });

  it("validates its required explicit policy", () => {
    expect(() =>
      attributeMetricDelta(metric(25), metric(26), [entity], {
        limit: Number.NaN,
        blockWorsening: true,
      }),
    ).toThrow(TypeError);
    expect(() =>
      attributeMetricDelta(metric(25), metric(26), [entity], {
        limit: 20,
        blockWorsening: "yes" as unknown as boolean,
      }),
    ).toThrow(TypeError);
  });
});
