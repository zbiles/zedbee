import { expect, it } from "vitest";
import {
  analyzerDiagnostic,
  sanitizeAnalyzerDiagnostic,
} from "../../../src/checks/diagnostics.js";
import { sanitizeCheckResult } from "../../../src/checks/sanitize-result.js";

it("copies only allowlisted diagnostic fields through the public result boundary", () => {
  const diagnostic = {
    ...analyzerDiagnostic("types", "collect", "abnormal-exit", 7, "SIGABRT"),
    stderr: "fixture-secret-marker",
    stack: "/private/fixture-secret-marker",
    environment: { TOKEN: "fixture-secret-marker" },
  };
  const result = sanitizeCheckResult({
    checkId: "types",
    status: "incomplete",
    durationMs: 0,
    findings: [],
    error: {
      code: "ANALYZER_FAILED",
      message: "The analyzer could not finish.",
      diagnostic,
    },
  });
  expect(result.error?.diagnostic).toEqual(
    analyzerDiagnostic("types", "collect", "abnormal-exit", 7, "SIGABRT"),
  );
  expect(JSON.stringify(result)).not.toContain("fixture-secret-marker");
});

it.each(["category", "operation", "signal", "checkId"])(
  "rejects unrecognized %s values",
  (field) => {
    expect(() =>
      sanitizeAnalyzerDiagnostic({
        ...analyzerDiagnostic("types", "collect", "execution"),
        [field]: "fixture-secret-marker",
      }),
    ).toThrow();
  },
);
