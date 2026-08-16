import { describe, expect, it } from "vitest";
import type { ICruiseResult, IViolation } from "dependency-cruiser";
import {
  canonicalCycle,
  normalizeDependencyViolations,
} from "../../../src/checks/dependency-architecture/normalize-graph.js";
import { DEPENDENCY_RULE_NAMES } from "../../../src/checks/dependency-architecture/rules.js";

function result(violations: readonly IViolation[]): ICruiseResult {
  return {
    modules: [],
    summary: {
      error: violations.length,
      warn: 0,
      info: 0,
      ignore: 0,
      totalCruised: 0,
      violations: [...violations],
      optionsUsed: {},
      environment: {
        version: "18.2.0",
        nodeVersionSupported: ">=22",
        nodeVersionFound: process.version,
        osVersionFound: process.platform,
        transpilersFound: [],
        extensionsFound: [],
      },
    },
  };
}

function violation(
  rule: string,
  overrides: Partial<IViolation> = {},
): IViolation {
  return {
    rule: { name: rule, severity: "error" },
    from: "src/a.ts",
    to: "src/b.ts",
    ...overrides,
  };
}

describe("dependency graph normalization", () => {
  it("canonicalizes cycle rotation and direction", () => {
    expect(canonicalCycle(["b.ts", "c.ts", "a.ts"])).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
    expect(canonicalCycle(["a.ts", "c.ts", "b.ts"])).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  it("emits stable path-only observations for every managed rule", () => {
    const observations = normalizeDependencyViolations(
      result([
        violation(DEPENDENCY_RULE_NAMES.circular, {
          cycle: [
            { name: "src/b.ts", dependencyTypes: ["local"] },
            { name: "src/c.ts", dependencyTypes: ["local"] },
          ],
        }),
        violation(DEPENDENCY_RULE_NAMES.unresolved, {
          to: "missing",
          unresolvedTo: "./missing.js",
        }),
        violation(DEPENDENCY_RULE_NAMES.missingDependency, {
          to: "left-pad",
          unresolvedTo: "left-pad",
        }),
        violation(DEPENDENCY_RULE_NAMES.productionToDev, { to: "vitest" }),
        violation(DEPENDENCY_RULE_NAMES.sourceToTest, { to: "test/helper.ts" }),
      ]),
      "/snapshot",
      new Set(["src/a.ts"]),
    );

    expect(observations).toHaveLength(5);
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: DEPENDENCY_RULE_NAMES.circular,
          identity: expect.stringContaining("cycle:src/a.ts>src/b.ts>src/c.ts"),
          location: { file: "src/a.ts" },
        }),
        expect.objectContaining({
          rule: DEPENDENCY_RULE_NAMES.unresolved,
          identity: expect.stringContaining("./missing.js"),
        }),
      ]),
    );
  });

  it("fails closed on unknown rules and unsafe paths while filtering another workspace", () => {
    expect(() =>
      normalizeDependencyViolations(
        result([violation("project-rule")]),
        "/snapshot",
        new Set(["src/a.ts"]),
      ),
    ).toThrow(/unsupported dependency rule/i);
    expect(() =>
      normalizeDependencyViolations(
        result([
          violation(DEPENDENCY_RULE_NAMES.unresolved, { from: "../a.ts" }),
        ]),
        "/snapshot",
        new Set(["src/a.ts"]),
      ),
    ).toThrow();
    expect(
      normalizeDependencyViolations(
        result([violation(DEPENDENCY_RULE_NAMES.unresolved)]),
        "/snapshot",
        new Set(["src/other.ts"]),
      ),
    ).toEqual([]);
  });
});
