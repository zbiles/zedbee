import { describe, expect, it } from "vitest";
import { sanitizeKnipReply } from "../../../src/checks/dead-code/executor.js";
import { DEPENDENCY_LIMITS } from "../../../src/cache/dependency-inputs.js";

describe("fixed Knip worker protocol", () => {
  it.each([
    null,
    {},
    { type: "error" },
    { type: "result", report: null },
    { type: "result", report: { issues: {} } },
    { type: "result", report: { issues: [] }, source: "not permitted" },
    {
      type: "result",
      report: { issues: [] },
      dependencyInputs: { version: 2 },
    },
  ])("rejects malformed replies without exposing partial results", (value) => {
    expect(() => sanitizeKnipReply(value)).toThrow();
  });
  it("rejects an oversized or out-of-scope input manifest", () => {
    for (const probes of [
      [{ kind: "missing", path: "baseline:../../private-file" }],
      Array.from({ length: DEPENDENCY_LIMITS.probes + 1 }, (_, index) => ({
        kind: "missing",
        path: `baseline:${index}`,
      })),
    ]) {
      expect(() =>
        sanitizeKnipReply({
          type: "result",
          report: { issues: [] },
          dependencyInputs: { version: 1, roots: "a".repeat(64), probes },
        }),
      ).toThrow();
    }
  });
});
