import type { IFlattenedRuleSet } from "dependency-cruiser";

const TEST_PATH =
  "(^|/)(?:test|tests|__tests__|spec)(?:/|$)|\\.(?:test|spec)\\.[^.]+$";
const PRODUCTION_SOURCE = "(^|/)src/";

export const DEPENDENCY_RULE_NAMES = Object.freeze({
  circular: "no-circular",
  unresolved: "no-unresolved",
  missingDependency: "no-missing-dependency",
  productionToDev: "no-production-to-dev-dependency",
  sourceToTest: "no-source-to-test",
});

export function createManagedDependencyRules(): IFlattenedRuleSet {
  return {
    forbidden: [
      {
        name: DEPENDENCY_RULE_NAMES.circular,
        severity: "error" as const,
        from: {},
        to: { circular: true },
      },
      {
        name: DEPENDENCY_RULE_NAMES.unresolved,
        severity: "error" as const,
        from: {},
        to: { couldNotResolve: true },
      },
      {
        name: DEPENDENCY_RULE_NAMES.missingDependency,
        severity: "error" as const,
        from: { pathNot: TEST_PATH },
        to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
      },
      {
        name: DEPENDENCY_RULE_NAMES.productionToDev,
        severity: "error" as const,
        from: { pathNot: TEST_PATH },
        to: { dependencyTypes: ["npm-dev"] },
      },
      {
        name: DEPENDENCY_RULE_NAMES.sourceToTest,
        severity: "error" as const,
        from: { path: PRODUCTION_SOURCE, pathNot: TEST_PATH },
        to: { path: TEST_PATH },
      },
    ],
  };
}

export const managedDependencyRules = createManagedDependencyRules();
