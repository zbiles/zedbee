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

it("does not classify arbitrary hook files as tests or exempt undeclared imports", () => {
  const rules = managedDependencyRules.forbidden!;
  const missing = rules.find(
    (rule) => rule.name === DEPENDENCY_RULE_NAMES.missingDependency,
  )!;
  const dev = rules.find(
    (rule) => rule.name === DEPENDENCY_RULE_NAMES.productionToDev,
  )!;
  const boundary = rules.find(
    (rule) => rule.name === DEPENDENCY_RULE_NAMES.sourceToTest,
  )!;
  expect(
    new RegExp(missing.from.pathNot as string).test(".husky/install.mjs"),
  ).toBe(false);
  expect(new RegExp(dev.from.pathNot as string).test(".husky/custom.js")).toBe(
    false,
  );
  expect(
    new RegExp(dev.from.pathNot as string).test(".husky/install.mjs"),
  ).toBe(true);
  if (!("to" in boundary)) throw new Error("Expected dependency rule");
  expect(new RegExp(boundary.to.path as string).test(".husky/custom.js")).toBe(
    false,
  );
});
