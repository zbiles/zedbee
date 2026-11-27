import { expect, it } from "vitest";
import type { CheckResult } from "../../src/core/types.js";
import { renderJson } from "../../src/renderers/json.js";
import { renderText } from "../../src/renderers/text.js";
import { createReport } from "../helpers/scan-report.js";

function missingInstall(
  checkId: string,
  target: string,
  error: Partial<NonNullable<CheckResult["error"]>> = {},
): CheckResult {
  return {
    checkId,
    target,
    status: "incomplete",
    incompleteDisposition: "block",
    durationMs: 1,
    findings: [],
    error: {
      code: "COMPARISON_INSTALLATION_UNAVAILABLE",
      message: `This checkout cannot resolve 'fixture' for workspace '${target}'.`,
      path: `${target}/package.json`,
      remediation: `Run npm --prefix ${target} ci from the repository root, then rerun the scan.`,
      snapshot: "last-commit",
      ...error,
    },
  };
}

it("shows one fix per workspace while retaining every incomplete check in JSON", () => {
  const checks = ["e2e", "extension"].flatMap((target) =>
    ["lint", "types"].map((check) => missingInstall(check, target)),
  );
  const report = createReport({ checks, outcome: "incomplete", exitCode: 2 });
  const output = renderText(report, { width: 80, color: false });

  expect(output.match(/COMPARISON INSTALLATION UNAVAILABLE/gu)).toHaveLength(2);
  expect(output.match(/Checks: Lint, TypeScript/gu)).toHaveLength(2);
  expect(output).toContain("npm --prefix e2e ci");
  expect(output).toContain("npm --prefix extension ci");
  expect(JSON.parse(renderJson(report)).checks).toHaveLength(4);
});

it("keeps different merge parents, sides, and causes visible", () => {
  const first = "a".repeat(40);
  const second = "b".repeat(40);
  const checks: CheckResult[] = [
    missingInstall("lint", "e2e", { comparisonParent: first }),
    missingInstall("types", "e2e", { comparisonParent: second }),
    missingInstall("types", "e2e", { snapshot: "staged" }),
    missingInstall("lint", "e2e", {
      comparisonParent: first,
      message: "This checkout cannot resolve 'another' for workspace 'e2e'.",
    }),
  ];
  const report = createReport({
    checks,
    mergeParents: [first, second],
    baseline: first,
    outcome: "incomplete",
    exitCode: 2,
  });
  const output = renderText(report, { width: 80, color: false });

  expect(output.match(/COMPARISON INSTALLATION UNAVAILABLE/gu)).toHaveLength(4);
  expect(output).toContain("Checked version: Merge parent aaaaaaaaaaaa");
  expect(output).toContain("Checked version: Merge parent bbbbbbbbbbbb");
  expect(output).toContain("Checked version: Staged merge");
  expect(JSON.parse(renderJson(report)).checks[0].error.comparisonParent).toBe(
    first,
  );
});

it("shows actionable incomplete details at 40 columns when writing a report fails", () => {
  const checks = ["lint", "types"].map((check) => missingInstall(check, "e2e"));
  const output = renderText(
    createReport({ checks, outcome: "incomplete", exitCode: 2 }),
    {
      width: 40,
      color: false,
      presentation: {
        automatic: true,
        reportStatus: "unavailable",
        findings: [],
        totalFindingCount: 0,
        abbreviated: false,
        warnings: [],
      },
    },
  );
  expect(output).toContain("REPORT UNAVAILABLE");
  expect(output).toContain("SCAN INCOMPLETE");
  expect(output).toContain("Checks: Lint, TypeScript");
  expect(output).toContain("npm --prefix e2e ci");
  expect(output).not.toContain("COMPLETE REPORT");
  for (const line of output.split("\n"))
    expect([...line].length).toBeLessThanOrEqual(40);
});
