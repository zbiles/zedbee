import { expect, it } from "vitest";
import {
  eslintFailureDetails,
  ManagedEslintFailure,
} from "../../../src/checks/eslint/failure.js";

it("discards exception names, unowned rules, source, paths and causes", () => {
  const error = Object.assign(new Error("fixture-secret-source"), {
    name: "fixture-secret-name",
    ruleId: "project/fixture-secret-rule",
    filePath: "/private/fixture-secret-file",
    cause: new Error("fixture-secret-cause"),
  });
  const wrapped = new ManagedEslintFailure("src/known.ts", error);
  expect(wrapped.details).toEqual({ type: "Error" });
  expect(wrapped.path).toBe("src/known.ts");
  expect(JSON.stringify(wrapped)).not.toContain("fixture-secret");
  expect(wrapped.cause).toBeUndefined();
});

it("does not misdiagnose an unrelated TypeError in a known rule", () => {
  const error = Object.assign(new TypeError("fixture-secret-source"), {
    ruleId: "@typescript-eslint/no-misused-promises",
  });
  expect(eslintFailureDetails(error)).toEqual({
    type: "TypeError",
    ruleId: "@typescript-eslint/no-misused-promises",
  });
});

it("does not let a throwing stack accessor replace the lint failure", () => {
  const error = Object.assign(
    new TypeError("Cannot read properties of undefined (reading 'some')"),
    {
      ruleId: "@typescript-eslint/no-misused-promises",
    },
  );
  Object.defineProperty(error, "stack", {
    get() {
      throw new Error("fixture-secret");
    },
  });
  expect(eslintFailureDetails(error)).toEqual({
    type: "TypeError",
    ruleId: "@typescript-eslint/no-misused-promises",
  });
});

it("does not accept rule IDs through exception getters", () => {
  const error = new Error("fixture-secret");
  Object.defineProperty(error, "ruleId", {
    get() {
      throw new Error("unexpected getter");
    },
  });
  expect(eslintFailureDetails(error)).toEqual({ type: "Error" });
});
