import { expect, it } from "vitest";
import {
  RECOMMENDED_AGENT_GUIDANCE,
  resolveAgentNextStep,
} from "../../src/reporting/agent-guidance.js";
import { createReport } from "../helpers/scan-report.js";
it("replaces generated repair guidance on clean scans and preserves custom opt-outs", () => {
  const report = createReport();
  expect(resolveAgentNextStep(report, RECOMMENDED_AGENT_GUIDANCE)).toBe(
    "No findings require action.",
  );
  expect(
    resolveAgentNextStep(report, { opening: "", nextStep: "Custom" }),
  ).toBe("Custom");
  expect(resolveAgentNextStep(report, { opening: "", nextStep: "" })).toBe("");
});
it("reports all skipped, warnings and nonblocking incomplete honestly", () => {
  const report = createReport({
    checks: [
      {
        checkId: "types",
        status: "skipped",
        durationMs: 0,
        findings: [],
        skipReason: "Not applicable",
      },
    ],
  });
  expect(resolveAgentNextStep(report, RECOMMENDED_AGENT_GUIDANCE)).toContain(
    "no configured checks ran",
  );
  expect(
    resolveAgentNextStep(
      createReport({
        summary: { ...report.summary, warnings: 1, incomplete: 1 },
      }),
      RECOMMENDED_AGENT_GUIDANCE,
    ),
  ).toMatch(/Review warnings.*Resolve.*incomplete/s);
});
it("mentions only the needed repair work and uses committed-mode instructions", () => {
  const summary = {
    passed: 0,
    warnings: 0,
    failed: 1,
    incomplete: 0,
    findings: [],
  };
  const blocked = createReport({ outcome: "blocked", summary });
  const guidance = resolveAgentNextStep(blocked, RECOMMENDED_AGENT_GUIDANCE);
  expect(guidance).toContain("Fix every blocking finding");
  expect(guidance).not.toContain("Review warnings");
  expect(guidance).not.toContain("incomplete checks");
  expect(
    resolveAgentNextStep(
      { ...blocked, mode: "base" },
      RECOMMENDED_AGENT_GUIDANCE,
    ),
  ).toContain("Commit any fixes");
  expect(
    resolveAgentNextStep(
      { ...blocked, mode: "base" },
      RECOMMENDED_AGENT_GUIDANCE,
    ),
  ).not.toContain("Stage");
});
