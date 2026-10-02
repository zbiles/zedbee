import { expect, it } from "vitest";
import {
  analyzerDiagnostic,
  sanitizeAnalyzerDiagnostic,
} from "../../../src/checks/diagnostics.js";
import { sanitizeCheckResult } from "../../../src/checks/sanitize-result.js";
import { decodeWorkerResponse } from "../../../src/checks/runner/envelope.js";
import type { AnalyzerRequest } from "../../../src/checks/runner/protocol.js";

const failure = {
  type: "TypeError",
  ruleId: "@typescript-eslint/no-misused-promises",
  reason: "rule-execution-incompatible-types",
} as const;

it("preserves bounded lint failure details through the worker and public result boundaries", () => {
  const diagnostic = {
    ...analyzerDiagnostic("lint", "collect", "execution"),
    snapshot: "target" as const,
    failure,
    stack: "/private/fixture-secret-marker",
  };
  const decoded = decodeWorkerResponse(
    { checkId: "lint", operation: "collect" } as AnalyzerRequest,
    {
      version: 1,
      ok: false,
      category: "execution",
      incomplete: {
        code: "TYPED_LINT_ANALYSIS_FAILED",
        message: "Typed lint failed in a managed rule.",
        remediation: "Reinstall Zedbee.",
        path: "src/second.ts",
        paths: ["src/second.ts"],
        diagnostic,
      },
    },
  );
  expect(decoded).toHaveProperty("error.diagnostic.failure", failure);
  expect(decoded).toHaveProperty("error.diagnostic.snapshot", "target");
  const result = sanitizeCheckResult({
    checkId: "lint",
    status: "incomplete",
    durationMs: 0,
    findings: [],
    error: {
      code: "TYPED_LINT_ANALYSIS_FAILED",
      message: "Typed lint failed in a managed rule.",
      diagnostic,
    },
  });
  expect(result.error?.diagnostic).toHaveProperty("failure", failure);
  expect(JSON.stringify({ decoded, result })).not.toContain(
    "fixture-secret-marker",
  );
});

it.each([
  { type: "fixture-secret-marker" },
  { ruleId: "project/fixture-secret-marker" },
  { reason: "fixture-secret-marker" },
])("rejects unrecognized lint failure metadata %j", (failure) => {
  expect(() =>
    sanitizeAnalyzerDiagnostic({
      ...analyzerDiagnostic("lint", "collect", "execution"),
      failure,
    } as Parameters<typeof sanitizeAnalyzerDiagnostic>[0]),
  ).toThrow();
});

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
