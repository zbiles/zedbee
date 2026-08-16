import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { OutcomeStrip } from "../../src/ui/outcome-strip.js";
import { createReport } from "../helpers/scan-report.js";

describe("OutcomeStrip", () => {
  it("preserves the exact failure copy and horizontal brand ordering", () => {
    const report = createReport({
      outcome: "blocked",
      exitCode: 1,
      summary: {
        passed: 2,
        warnings: 1,
        failed: 2,
        incomplete: 0,
        findings: []
      }
    });
    const frame = render(
      <OutcomeStrip report={report} width={120} color={false} />
    ).lastFrame()!;

    expect(frame).toContain("THAT STINGS");
    expect(frame).toContain("A check failed. Commit blocked.");
    expect(frame).toContain("2 passed · 1 warning · 2 failed");
    expect(frame).not.toContain("…");
    expect(frame).not.toContain("elapsed");
    const headlineLine = frame.split("\n").find((line) => line.includes("THAT STINGS"))!;
    expect(headlineLine.indexOf("●")).toBeLessThan(headlineLine.indexOf("THAT STINGS"));
    expect(headlineLine.indexOf("THAT STINGS")).toBeLessThan(headlineLine.lastIndexOf("██"));
  });

  it("preserves the exact passing copy", () => {
    const report = createReport({
      summary: {
        passed: 5,
        warnings: 0,
        failed: 0,
        incomplete: 0,
        findings: []
      }
    });
    const frame = render(
      <OutcomeStrip report={report} width={120} color={false} />
    ).lastFrame()!;

    expect(frame).toContain("BEE-UTIFUL");
    expect(frame).toContain("All checks passed. Commit allowed.");
    expect(frame).toContain("5 passed · 0 warnings");
  });

  it("keeps traffic light, shortened copy, motion dashes, and bee in order when narrow", () => {
    const frame = render(
      <OutcomeStrip report={createReport()} width={78} color={false} />
    ).lastFrame()!;
    const firstLine = frame.split("\n")[0]!;

    expect(firstLine.indexOf("●")).toBeLessThan(firstLine.indexOf("BEE-UTIFUL"));
    expect(firstLine.indexOf("BEE-UTIFUL")).toBeLessThan(firstLine.lastIndexOf("██"));
  });
});
