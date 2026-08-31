import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { TerminalPresentation } from "../../src/reporting/presentation.js";
import { ScanResultDashboard } from "../../src/ui/scan-result-dashboard.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

const reportPath = "/private/tmp/zedbee-reports/hash/complete.json";

function presentation(
  overrides: Partial<TerminalPresentation> = {},
): TerminalPresentation {
  return {
    automatic: true,
    reportStatus: "available",
    findings: [],
    totalFindingCount: 0,
    abbreviated: false,
    reportPath,
    maximumAge: "24h",
    warnings: [],
    ...overrides,
  };
}

function dashboard(
  report = createReport(),
  shown = presentation(),
  options: { width?: number; color?: boolean } = {},
): string {
  return render(
    <ScanResultDashboard
      report={report}
      presentation={shown}
      width={options.width ?? 120}
      color={options.color ?? false}
    />,
  ).lastFrame()!;
}

function expectOrder(output: string, headings: readonly string[]): void {
  let previous = -1;
  for (const heading of headings) {
    const current = output.indexOf(heading, previous + 1);
    expect(current, `${heading} follows the previous section`).toBeGreaterThan(
      previous,
    );
    previous = current;
  }
}

function expectBlankRowAfterPanelHeading(
  output: string,
  heading: string,
): void {
  const lines = output.split("\n");
  const headingIndex = lines.findIndex((line) => line.includes(heading));
  expect(headingIndex, `${heading} is rendered`).toBeGreaterThanOrEqual(0);
  const headingLine = lines[headingIndex]!;
  const leftBorder = headingLine.indexOf("│");
  const rightBorder = headingLine.lastIndexOf("│");
  expect(
    leftBorder,
    `${heading} has a left panel border`,
  ).toBeGreaterThanOrEqual(0);
  expect(rightBorder, `${heading} has a right panel border`).toBeGreaterThan(
    leftBorder,
  );
  expect(
    lines[headingIndex + 2]!.slice(leftBorder, rightBorder + 1).replaceAll(
      " ",
      "",
    ),
    `${heading} content starts after one blank row`,
  ).toBe("││");
  expect(
    lines[headingIndex + 3]!.slice(leftBorder, rightBorder + 1).replaceAll(
      " ",
      "",
    ),
    `${heading} content follows the blank row immediately`,
  ).not.toBe("││");
}

function expectPanelsTouch(
  output: string,
  upperHeading: string,
  lowerHeading: string,
): void {
  const lines = output.split("\n");
  const upperHeadingIndex = lines.findIndex((line) =>
    line.includes(upperHeading),
  );
  const lowerHeadingIndex = lines.findIndex((line) =>
    line.includes(lowerHeading),
  );
  const upperBottomIndex = lines.findIndex(
    (line, index) => index > upperHeadingIndex && line.includes("└"),
  );
  let lowerTopIndex = lowerHeadingIndex;
  while (lowerTopIndex >= 0 && !lines[lowerTopIndex]!.includes("┌")) {
    lowerTopIndex -= 1;
  }

  expect(upperHeadingIndex).toBeGreaterThanOrEqual(0);
  expect(lowerHeadingIndex).toBeGreaterThan(upperHeadingIndex);
  expect(upperBottomIndex).toBeGreaterThan(upperHeadingIndex);
  expect(lowerTopIndex).toBeGreaterThan(upperBottomIndex);
  expect(
    lowerTopIndex,
    `${lowerHeading} starts immediately after ${upperHeading}`,
  ).toBe(upperBottomIndex + 1);
}

describe("ScanResultDashboard", () => {
  it("keeps generated managed-fix guidance out of the permanent post-frame callout", () => {
    const finding = createFinding({
      id: "fixable",
      check: "lint",
      automaticFix: {
        available: true,
        command: ["npx", "--no-install", "zedbee", "fix", "lint"],
        scope: "finding",
        writes: "working-tree",
        stagesChanges: false,
      },
    });
    const secondFinding = { ...finding, id: "fixable-two" };
    const output = dashboard(
      createReport({
        summary: {
          passed: 0,
          warnings: 0,
          failed: 2,
          incomplete: 0,
          findings: [finding, secondFinding],
        },
        presentationPolicy: {
          terminalFindingLimit: "all",
          temporaryReportMaxAge: "24h",
          persistSourceExcerpts: false,
          agentGuidance: { opening: "", nextStep: "Apply a managed fix." },
        },
      }),
      presentation({
        findings: [finding, secondFinding],
        totalFindingCount: 2,
      }),
    );

    expect(output).toContain("AGENT NEXT STEP");
    expect(output).toContain("Apply a managed fix.");
    expect(output).toContain("COMPLETE REPORT");
    expect(output).not.toContain(
      "Managed fix commands write the working tree; they do not stage changes.",
    );
    expect(output).not.toContain("npx --no-install zedbee fix lint");
  });

  it("frames a passing result and prints the complete report above and below", () => {
    const output = dashboard(
      createReport({
        presentationPolicy: {
          terminalFindingLimit: 25,
          temporaryReportMaxAge: "24h",
          persistSourceExcerpts: false,
          agentGuidance: {
            opening: "Review the complete result before continuing.",
            nextStep: "Continue only when the report outcome allows it.",
          },
        },
      }),
    );

    expect(output).toContain("SCAN RESULT");
    expect(output).toContain("COMMIT ALLOWED");
    expect(output).toContain("▀▀▀▀█ █▀▀▀▀");
    expect(output).toContain("█");
    expect(output.match(/COMPLETE REPORT/gu)).toHaveLength(2);
    expect(output.match(/complete\.json/gu)).toHaveLength(2);
    expectOrder(output, [
      "AGENT GUIDANCE",
      "COMPLETE REPORT",
      "SCAN RESULT",
      "AGENT NEXT STEP",
      "COMPLETE REPORT",
    ]);
  });

  it("separates blocking and warning findings while retaining finding detail", () => {
    const blocking = createFinding({
      id: "blocking",
      rule: "no-unsafe-call",
      sourceExcerpt: {
        line: 2,
        text: "unsafeCall()",
        redacted: false,
        truncated: false,
      },
    });
    const warning = createFinding({
      id: "warning",
      severity: "warning",
      rule: "prefer-const",
    });
    const hidden = createFinding({ id: "hidden", rule: "hidden-rule" });
    const output = dashboard(
      createReport({
        outcome: "blocked",
        exitCode: 1,
        summary: {
          passed: 0,
          warnings: 1,
          failed: 2,
          incomplete: 0,
          findings: [blocking, warning, hidden],
        },
      }),
      presentation({
        findings: [blocking, warning],
        totalFindingCount: 3,
        abbreviated: true,
      }),
    );

    expectOrder(output, ["BLOCKING FINDINGS", "WARNINGS", "SCAN RESULT"]);
    expect(output.match(/BLOCKING FINDINGS/gu)).toHaveLength(1);
    expect(output.match(/WARNINGS/gu)).toHaveLength(1);
    expect(output).toContain("Prettier  no-unsafe-call");
    expect(output).toContain("src/value.ts:2");
    expect(output).toContain("2 │ unsafeCall()");
    expect(output).toContain(
      "Issue: Staged code does not match the managed format.",
    );
    expect(output).toContain(
      "Fix: Format the staged lines, then stage the result.",
    );
    expect(output).toContain("Prettier  prefer-const");
    expect(output).not.toContain("hidden-rule");
  });

  it("orders disclosures, incomplete checks, and report warnings after findings", () => {
    const blocking = createFinding({ id: "blocking", rule: "blocking" });
    const warning = createFinding({
      id: "warning",
      severity: "warning",
      rule: "warning",
    });
    const output = dashboard(
      createReport({
        outcome: "incomplete",
        exitCode: 2,
        summary: {
          passed: 0,
          warnings: 1,
          failed: 1,
          incomplete: 1,
          findings: [blocking, warning],
        },
        networkDisclosures: [
          {
            checkId: "vulnerabilities",
            target: ".",
            services: ["api.osv.dev"],
            metadata: ["package names"],
          },
        ],
        checks: [
          {
            checkId: "vulnerabilities",
            status: "incomplete",
            durationMs: 3,
            findings: [],
            error: {
              code: "OSV_UNAVAILABLE",
              message: "OSV is unavailable.",
              remediation: "Restore network access, then scan again.",
            },
          },
        ],
      }),
      presentation({
        findings: [blocking, warning],
        totalFindingCount: 2,
        warnings: [
          {
            code: "TEMP_REPORT_CLEANUP_FAILED",
            message: "An expired report remains.",
          },
        ],
      }),
    );

    expectOrder(output, [
      "BLOCKING FINDINGS",
      "WARNINGS",
      "DISCLOSURES",
      "REPORT WARNINGS",
      "INCOMPLETE CHECKS",
      "SCAN RESULT",
    ]);
    for (const [upper, lower] of [
      ["BLOCKING FINDINGS", "WARNINGS"],
      ["WARNINGS", "DISCLOSURES"],
      ["DISCLOSURES", "REPORT WARNINGS"],
      ["REPORT WARNINGS", "INCOMPLETE CHECKS"],
      ["INCOMPLETE CHECKS", "SCAN RESULT"],
    ] as const) {
      expectPanelsTouch(output, upper, lower);
    }
    expect(output).toContain(
      "vulnerabilities sent package names to api.osv.dev.",
    );
    expect(output).toContain("OSV UNAVAILABLE");
    expect(output).toContain("Fix: Restore network access, then scan again.");
    expect(output).toContain("TEMP REPORT CLEANUP FAILED");
    expect(output).toContain(
      "Review INCOMPLETE CHECKS above for details. Commit blocked.",
    );
    expect(output).toContain(
      "0 checks passed · 1 blocking finding · 1 warning finding",
    );
  });

  it("stacks blocking findings directly against incomplete checks", () => {
    const blocking = createFinding({ id: "blocking", rule: "blocking" });
    const output = dashboard(
      createReport({
        outcome: "incomplete",
        exitCode: 2,
        summary: {
          passed: 0,
          warnings: 0,
          failed: 1,
          incomplete: 1,
          findings: [blocking],
        },
        checks: [
          {
            checkId: "lint",
            status: "incomplete",
            durationMs: 3,
            findings: [],
            error: {
              code: "TYPED_LINT_PROJECT_MISMATCH",
              message:
                "Zedbee found TypeScript files outside every loaded project.",
              path: "tools/remotion.config.ts",
              paths: ["docs/.vitepress/config.mts", "tools/remotion.config.ts"],
              snapshot: "last-commit",
              projectPaths: ["tools/tsconfig.json"],
            },
          },
        ],
      }),
      presentation({ findings: [blocking], totalFindingCount: 1 }),
    );

    expectPanelsTouch(output, "BLOCKING FINDINGS", "INCOMPLETE CHECKS");
    expect(output).toContain("Checked version: Previous commit");
    expect(output).toContain("Loaded project: tools/tsconfig.json");
    expect(output).toContain("Affected files: 2");
    expect(output).toContain("File: docs/.vitepress/config.mts");
    expect(output).toContain("File: tools/remotion.config.ts");
  });

  it("balances every result panel with a blank row above its content", () => {
    const blocking = createFinding({ id: "blocking", rule: "blocking" });
    const warning = createFinding({
      id: "warning",
      severity: "warning",
      rule: "warning",
    });
    const output = dashboard(
      createReport({
        outcome: "incomplete",
        exitCode: 2,
        summary: {
          passed: 0,
          warnings: 1,
          failed: 1,
          incomplete: 1,
          findings: [blocking, warning],
        },
        networkDisclosures: [
          {
            checkId: "vulnerabilities",
            target: ".",
            services: ["api.osv.dev"],
            metadata: ["package names"],
          },
        ],
        checks: [
          {
            checkId: "vulnerabilities",
            status: "incomplete",
            durationMs: 3,
            findings: [],
            error: {
              code: "OSV_UNAVAILABLE",
              message: "OSV is unavailable.",
              remediation: "Restore network access, then scan again.",
            },
          },
        ],
      }),
      presentation({
        findings: [blocking, warning],
        totalFindingCount: 2,
        warnings: [
          {
            code: "TEMP_REPORT_CLEANUP_FAILED",
            message: "An expired report remains.",
          },
        ],
      }),
    );

    for (const heading of [
      "SCAN RESULT",
      "BLOCKING FINDINGS",
      "WARNINGS",
      "DISCLOSURES",
      "INCOMPLETE CHECKS",
      "REPORT WARNINGS",
    ]) {
      expectBlankRowAfterPanelHeading(output, heading);
    }
  });

  it("shows cleanup warning paths while retaining a valid report path", () => {
    const warningPath = "/private/tmp/zedbee-reports/hash/expired-report.json";
    const output = dashboard(
      createReport(),
      presentation({
        warnings: [
          {
            code: "TEMP_REPORT_CLEANUP_FAILED",
            message: "An expired report could not be removed.",
            path: warningPath,
          },
        ],
      }),
    );

    expect(output).toContain("REPORT WARNINGS");
    expect(output).toContain("Path:");
    expect(output).toContain("expired-report.json");
    expect(output.match(/complete\.json/gu)).toHaveLength(2);
  });

  it("shows every selected finding when the report is unavailable without inventing a path", () => {
    const first = createFinding({ id: "first", rule: "first-rule" });
    const second = createFinding({ id: "second", rule: "second-rule" });
    const output = dashboard(
      createReport({
        outcome: "blocked",
        exitCode: 1,
        summary: {
          passed: 0,
          warnings: 0,
          failed: 2,
          incomplete: 0,
          findings: [first, second],
        },
      }),
      {
        automatic: true,
        reportStatus: "unavailable",
        findings: [first, second],
        totalFindingCount: 2,
        abbreviated: false,
        completeOutputFallback: true,
        warnings: [
          {
            code: "TEMP_REPORT_WRITE_FAILED",
            message: "The temporary report could not be written.",
          },
        ],
      },
    );

    expect(output.match(/REPORT UNAVAILABLE/gu)).toHaveLength(2);
    expect(output).toContain("first-rule");
    expect(output).toContain("second-rule");
    expect(output).not.toContain("complete.json");
    expect(output).not.toContain("Full report:");
  });

  it("omits blank opening and next-step headings independently", () => {
    const openingBlank = dashboard(
      createReport({
        presentationPolicy: {
          terminalFindingLimit: 25,
          temporaryReportMaxAge: "24h",
          persistSourceExcerpts: false,
          agentGuidance: { opening: "", nextStep: "Resolve the result." },
        },
      }),
    );
    const nextStepBlank = dashboard(
      createReport({
        presentationPolicy: {
          terminalFindingLimit: 25,
          temporaryReportMaxAge: "24h",
          persistSourceExcerpts: false,
          agentGuidance: { opening: "Read the result.", nextStep: "" },
        },
      }),
    );

    expect(openingBlank).not.toContain("AGENT GUIDANCE");
    expect(openingBlank).toContain("AGENT NEXT STEP");
    expect(nextStepBlank).toContain("AGENT GUIDANCE");
    expect(nextStepBlank).not.toContain("AGENT NEXT STEP");
    expect(openingBlank.match(/COMPLETE REPORT/gu)).toHaveLength(2);
    expect(nextStepBlank.match(/COMPLETE REPORT/gu)).toHaveLength(2);
  });

  it("omits empty panels and remains meaningful without color at narrow width", () => {
    const output = dashboard(createReport(), presentation(), {
      width: 40,
      color: false,
    });

    expect(output).toContain("SCAN RESULT");
    expect(output).not.toContain("BLOCKING FINDINGS");
    expect(output).not.toContain("WARNINGS");
    expect(output).not.toContain("DISCLOSURES");
    expect(output).not.toContain("INCOMPLETE CHECKS");
    expect(output).not.toContain("REPORT WARNINGS");
    expect(output).not.toMatch(/\u001B\[[0-9;]*m/u);
    expect(
      Math.max(...output.split("\n").map((line) => [...line].length)),
    ).toBeLessThanOrEqual(40);
  });
});
