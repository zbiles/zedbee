import { expect, it } from "vitest";
import { diagnosticCredentialValues } from "../../src/checks/diagnostic-secret-review.js";

it("finds quoted credential values", () => {
  expect(diagnosticCredentialValues('const password = "abc";')).toEqual([
    "abc",
  ]);
  expect(diagnosticCredentialValues("const api_key_value: 'xyz'")).toEqual([
    "xyz",
  ]);
});

it("stays linear on one long keyword-filled word", () => {
  expect(diagnosticCredentialValues("token_".repeat(200_000))).toEqual([]);
});
