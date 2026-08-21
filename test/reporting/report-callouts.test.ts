import { describe, expect, it } from "vitest";
import { buildReportCallouts } from "../../src/reporting/report-callouts.js";
import type { TerminalPresentation } from "../../src/reporting/presentation.js";

function presentation(
  overrides: Partial<TerminalPresentation> = {},
): TerminalPresentation {
  return {
    automatic: true,
    reportStatus: "available",
    findings: [],
    totalFindingCount: 0,
    abbreviated: false,
    reportPath: "/private/tmp/zedbee-reports/complete.json",
    maximumAge: "24h",
    warnings: [],
    ...overrides,
  };
}

describe("buildReportCallouts", () => {
  it("keeps configured guidance and report paths as separate typed callout lines", () => {
    const callouts = buildReportCallouts(presentation(), {
      opening: "Read the complete report.",
      nextStep: "Resolve blocking findings.",
    });

    expect(callouts).toEqual({
      opening: [
        { kind: "text", value: "AGENT GUIDANCE" },
        { kind: "text", value: "Read the complete report." },
        { kind: "text", value: "COMPLETE REPORT" },
        {
          kind: "report-path",
          path: "/private/tmp/zedbee-reports/complete.json",
        },
      ],
      closing: [
        { kind: "text", value: "AGENT NEXT STEP" },
        { kind: "text", value: "Resolve blocking findings." },
        { kind: "text", value: "COMPLETE REPORT" },
        {
          kind: "report-path",
          path: "/private/tmp/zedbee-reports/complete.json",
        },
      ],
    });
  });

  it("keeps both report-path callouts when either configured message is blank", () => {
    const openingBlank = buildReportCallouts(presentation(), {
      opening: "",
      nextStep: "Resolve blocking findings.",
    });
    const nextStepBlank = buildReportCallouts(presentation(), {
      opening: "Read the complete report.",
      nextStep: "",
    });
    const bothBlank = buildReportCallouts(presentation(), {
      opening: "",
      nextStep: "",
    });

    for (const callouts of [openingBlank, nextStepBlank, bothBlank]) {
      expect(
        callouts.opening.filter((line) => line.kind === "report-path"),
      ).toEqual([
        {
          kind: "report-path",
          path: "/private/tmp/zedbee-reports/complete.json",
        },
      ]);
      expect(
        callouts.closing.filter((line) => line.kind === "report-path"),
      ).toEqual([
        {
          kind: "report-path",
          path: "/private/tmp/zedbee-reports/complete.json",
        },
      ]);
    }
    expect(
      openingBlank.opening.map((line) => line.kind === "text" && line.value),
    ).not.toContain("AGENT GUIDANCE");
    expect(
      nextStepBlank.closing.map((line) => line.kind === "text" && line.value),
    ).not.toContain("AGENT NEXT STEP");
  });

  it("uses fixed complete-output notices without guidance or paths when the report is unavailable", () => {
    const { reportPath: _reportPath, ...unavailablePresentation } =
      presentation({
        reportStatus: "unavailable",
        completeOutputFallback: true,
      });
    const callouts = buildReportCallouts(unavailablePresentation, {
      opening: "Read the missing report.",
      nextStep: "Follow the missing report.",
    });

    expect(callouts).toEqual({
      opening: [
        { kind: "text", value: "REPORT UNAVAILABLE" },
        {
          kind: "text",
          value: "The terminal output is the complete source of truth.",
        },
      ],
      closing: [
        { kind: "text", value: "REPORT UNAVAILABLE" },
        {
          kind: "text",
          value: "The terminal output is the complete source of truth.",
        },
      ],
    });
  });

  it("does not create callouts for explicit complete text", () => {
    const { reportPath: _reportPath, ...explicitPresentation } = presentation({
      automatic: false,
      reportStatus: "not-requested",
    });
    expect(
      buildReportCallouts(explicitPresentation, {
        opening: "Read this.",
        nextStep: "Fix this.",
      }),
    ).toEqual({ opening: [], closing: [] });
  });
});
