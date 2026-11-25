import { expect, it } from "vitest";
import {
  allowedScanDetail,
  checkCoverage,
} from "../../src/reporting/check-coverage.js";
import { createReport } from "../helpers/scan-report.js";
it("distinguishes skipped work and empty execution from successful checks", () => {
  const checks = [
    {
      checkId: "types",
      status: "skipped" as const,
      durationMs: 0,
      findings: [],
      skipReason: "Not applicable",
    },
  ];
  expect(checkCoverage(createReport({ checks }))).toEqual({
    completed: 0,
    skipped: 1,
    incomplete: 0,
  });
  expect(allowedScanDetail(createReport({ checks }))).toBe(
    "No applicable checks for the staged changes. Commit allowed.",
  );
  expect(allowedScanDetail(createReport({ checks: [] }))).toBe(
    "No checks ran for the selected changes. Commit allowed.",
  );
  expect(
    allowedScanDetail(
      createReport({
        summary: {
          passed: 0,
          warnings: 1,
          failed: 0,
          incomplete: 0,
          findings: [],
        },
      }),
    ),
  ).not.toContain("All checks passed");
});
it("counts workspace executions independently from passed results", () => {
  const report = createReport({
    checks: [
      {
        checkId: "types",
        target: "a",
        status: "completed",
        durationMs: 1,
        findings: [],
      },
      {
        checkId: "types",
        target: "b",
        status: "completed",
        durationMs: 1,
        findings: [],
      },
      {
        checkId: "lint",
        status: "incomplete",
        durationMs: 1,
        findings: [],
        incompleteDisposition: "warn",
      },
    ],
  });
  expect(checkCoverage(report)).toEqual({
    completed: 2,
    skipped: 0,
    incomplete: 1,
  });
  expect(allowedScanDetail(report)).not.toContain("All checks passed");
});
it("preserves base and empty input wording", () => {
  const checks = [
    {
      checkId: "types",
      status: "skipped" as const,
      durationMs: 0,
      findings: [],
      skipReason: "Not applicable",
    },
  ];
  expect(allowedScanDetail(createReport({ checks, mode: "base" }))).toBe(
    "No applicable checks for the selected committed changes. Commit allowed.",
  );
  expect(
    allowedScanDetail(createReport({ checks: [], changedFileCount: 0 })),
  ).toBe("No staged changes. Commit allowed.");
});
