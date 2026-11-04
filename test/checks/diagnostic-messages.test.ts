import { describe, expect, it } from "vitest";
import type { CheckObservationSet } from "../../src/checks/adapter.js";
import { createDiagnosticMessageSanitizer } from "../../src/checks/diagnostic-messages.js";

const token = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
function set(message: string, checkId = "types"): CheckObservationSet {
  const observation = {
    check: checkId,
    rule: checkId === "types" ? "typescript/TS2322" : "fixture",
    identity: "fixture",
    severity: "error" as const,
    message,
  };
  return {
    checkId,
    target: { id: ".", kind: "repository", relativeRoot: "." },
    baselineObservations: [observation],
    targetObservations: [observation],
  };
}

describe("source-safe diagnostic messages", () => {
  it.each(["types", "lint", "reactCorrectness", "reactAccessibility"])(
    "masks detected values in %s prose before publication without losing the explanation",
    async (check) => {
      const input = set(
        `Type '${token}' is not assignable to type 'number'.`,
        check,
      );
      const output = await createDiagnosticMessageSanitizer()(input);
      expect(JSON.stringify(output)).not.toContain(token);
      expect(output.targetObservations[0]?.message).toContain(
        check === "types" ? "is not assignable" : "diagnostic",
      );
      expect(input.targetObservations[0]?.message).toContain(token);
    },
  );

  it("does not allow diagnostic text to disable privacy masking", async () => {
    const output = await createDiagnosticMessageSanitizer()(
      set(`// secretlint-disable\nType '${token}' is invalid.`),
    );
    expect(JSON.stringify(output)).not.toContain(token);
  });

  it("preserves the compiler explanation while omitting all substituted source values", async () => {
    const input = set("Type 'number' is not assignable to type 'string'.");
    expect(
      (await createDiagnosticMessageSanitizer()(input)).targetObservations[0]
        ?.message,
    ).toBe("Type '[source]' is not assignable to type '[source]'.");
  });
});
