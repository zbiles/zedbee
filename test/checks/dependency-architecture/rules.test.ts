import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_RULE_NAMES,
  managedDependencyRules,
} from "../../../src/checks/dependency-architecture/rules.js";

describe("managed dependency rules", () => {
  it("covers cycles, resolution, declarations, dev-only imports, and test boundaries", () => {
    expect(managedDependencyRules.forbidden?.map(({ name }) => name)).toEqual([
      DEPENDENCY_RULE_NAMES.circular,
      DEPENDENCY_RULE_NAMES.unresolved,
      DEPENDENCY_RULE_NAMES.missingDependency,
      DEPENDENCY_RULE_NAMES.productionToDev,
      DEPENDENCY_RULE_NAMES.sourceToTest,
    ]);
    expect(managedDependencyRules).not.toHaveProperty("extends");
    expect(managedDependencyRules).not.toHaveProperty("options");
    expect(managedDependencyRules.forbidden?.at(-1)?.from).toMatchObject({
      path: expect.any(String),
      pathNot: expect.any(String),
    });
  });
});
