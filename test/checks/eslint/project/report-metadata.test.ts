import { expect, it } from "vitest";
import { sanitizeCheckResult } from "../../../../src/checks/sanitize-result.js";
it("retains bounded project engine version and coverage without copying arbitrary fields", () => {
  const result = sanitizeCheckResult({
    checkId: "lint",
    status: "completed",
    durationMs: 1,
    findings: [],
    eslintAnalysis: {
      version: "9.39.5",
      checkedFiles: 2,
      ignoredFiles: 1,
      baseline: "compared",
      messages: "redacted",
      source: "PRIVATE",
    },
  } as never);
  expect(result).toHaveProperty("eslintAnalysis", {
    version: "9.39.5",
    checkedFiles: 2,
    ignoredFiles: 1,
    baseline: "compared",
    messages: "redacted",
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});
