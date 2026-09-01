import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { OutcomeStrip } from "../../src/ui/outcome-strip.js";
import { createReport } from "../helpers/scan-report.js";

function maxLineWidth(frame: string): number {
  return Math.max(...frame.split("\n").map((line) => [...line].length));
}

function collapsedWhitespace(frame: string): string {
  return frame.replaceAll(/\s+/gu, " ");
}

function baseReport() {
  return createReport({
    mode: "base",
    baseline: "a".repeat(40),
    target: "b".repeat(40),
    requestedBase: "origin/main",
    changedFileCount: 0,
    checks: [],
    summary: {
      passed: 0,
      warnings: 0,
      failed: 0,
      incomplete: 0,
      findings: [],
    },
  });
}

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
        findings: [],
      },
    });
    const frame = render(
      <OutcomeStrip report={report} width={120} color={false} />,
    ).lastFrame()!;

    expect(frame).toContain("THAT STINGS");
    expect(frame).toContain("A check failed. Commit blocked.");
    expect(frame).toContain("2 passed · 1 warning · 2 failed");
    expect(frame).not.toContain("…");
    expect(frame).not.toContain("elapsed");
    const headlineLine = frame
      .split("\n")
      .find((line) => line.includes("THAT STINGS"))!;
    expect(headlineLine.indexOf("●")).toBeLessThan(
      headlineLine.indexOf("THAT STINGS"),
    );
    expect(headlineLine.indexOf("THAT STINGS")).toBeLessThan(
      headlineLine.lastIndexOf("██"),
    );
  });

  it("preserves the exact passing copy", () => {
    const report = createReport({
      summary: {
        passed: 5,
        warnings: 0,
        failed: 0,
        incomplete: 0,
        findings: [],
      },
    });
    const frame = render(
      <OutcomeStrip report={report} width={120} color={false} />,
    ).lastFrame()!;

    expect(frame).toContain("BEE-UTIFUL");
    expect(frame).toContain("All checks passed. Commit allowed.");
    expect(frame).toContain("5 passed · 0 warnings");
  });

  it("reports an empty staged index instead of claiming checks passed", () => {
    const report = Object.assign(
      createReport({
        checks: [],
        summary: {
          passed: 0,
          warnings: 0,
          failed: 0,
          incomplete: 0,
          findings: [],
        },
      }),
      { changedFileCount: 0 },
    );
    const frame = render(
      <OutcomeStrip report={report} width={120} color={false} />,
    ).lastFrame()!;

    expect(frame).toContain("No staged changes. Commit allowed.");
    expect(frame).not.toContain("All checks passed");
  });

  it("renders committed source identity and empty-base copy", () => {
    const report = baseReport();

    const frame = render(
      <OutcomeStrip report={report} width={160} color={false} />,
    ).lastFrame()!;

    expect(frame).toContain("No committed changes. Commit allowed.");
    expect(frame).toContain(
      "Committed changes · base origin/main · aaaaaaaaaaaa..bbbbbbbbbbbb",
    );
    expect(frame).toContain("██");
    expect(frame).not.toMatch(/staged/iu);
  });

  it("renders safe unresolved provenance and omits an unsafe requested base", () => {
    const unresolved = createReport({
      mode: "base",
      baseline: null,
      target: null,
      requestedBase: "origin/missing",
      outcome: "incomplete",
      exitCode: 2,
    });
    const unsafeBase = `origin/main\u2066hidden`;
    const unsafe = createReport({
      ...unresolved,
      requestedBase: unsafeBase,
    });

    const unresolvedFrame = render(
      <OutcomeStrip report={unresolved} width={160} color={false} />,
    ).lastFrame()!;
    const unsafeFrame = render(
      <OutcomeStrip report={unsafe} width={160} color={false} />,
    ).lastFrame()!;

    expect(unresolvedFrame).toContain(
      "Committed changes · base origin/missing · unresolved",
    );
    expect(unsafeFrame).not.toContain(unsafeBase);
  });

  it.each([40, 60, 72, 78, 80, 96])(
    "retains complete base provenance and yields decorative art at %i columns",
    (width) => {
      const frame = render(
        <OutcomeStrip report={baseReport()} width={width} color={false} />,
      ).lastFrame()!;

      expect(collapsedWhitespace(frame)).toContain(
        "Committed changes · base origin/main · aaaaaaaaaaaa..bbbbbbbbbbbb",
      );
      expect(frame).not.toContain("██");
      expect(maxLineWidth(frame)).toBeLessThanOrEqual(width);
    },
  );

  it("does not mistake disabled checks for an empty staged index", () => {
    const report = Object.assign(
      createReport({
        checks: [],
        summary: {
          passed: 0,
          warnings: 0,
          failed: 0,
          incomplete: 0,
          findings: [],
        },
      }),
      { changedFileCount: 1 },
    );
    const frame = render(
      <OutcomeStrip report={report} width={120} color={false} />,
    ).lastFrame()!;

    expect(frame).toContain("All checks passed. Commit allowed.");
    expect(frame).not.toContain("No staged changes");
  });

  it("keeps traffic light, shortened copy, and bee in order at medium widths", () => {
    const frame = render(
      <OutcomeStrip report={createReport()} width={78} color={false} />,
    ).lastFrame()!;
    const firstLine = frame.split("\n")[0]!;

    expect(firstLine.indexOf("●")).toBeLessThan(
      firstLine.indexOf("BEE-UTIFUL"),
    );
    expect(firstLine.indexOf("BEE-UTIFUL")).toBeLessThan(
      firstLine.lastIndexOf("██"),
    );
    expect(maxLineWidth(frame)).toBeLessThanOrEqual(78);
  });

  it.each([20, 40])(
    "omits decorative art before it can overflow a %i-column terminal",
    (width) => {
      const frame = render(
        <OutcomeStrip report={createReport()} width={width} color={false} />,
      ).lastFrame()!;

      expect(frame).toContain("BEE-UTIFUL");
      expect(frame).toContain("Commit allowed.");
      expect(frame).not.toContain("██");
      expect(maxLineWidth(frame)).toBeLessThanOrEqual(width);
    },
  );

  it("fits the bee without trails in a 60-column terminal", () => {
    const frame = render(
      <OutcomeStrip report={createReport()} width={60} color={false} />,
    ).lastFrame()!;

    expect(frame).toContain("██");
    expect(maxLineWidth(frame)).toBeLessThanOrEqual(60);
  });

  it("retains pass, warning, and failure counts without a visual incomplete count", () => {
    const frame = render(
      <OutcomeStrip
        report={createReport({
          outcome: "incomplete",
          exitCode: 2,
          summary: {
            passed: 3,
            warnings: 2,
            failed: 1,
            incomplete: 1,
            findings: [],
          },
        })}
        width={120}
        color={false}
      />,
    ).lastFrame()!;

    expect(frame).toContain("SCAN INCOMPLETE");
    expect(frame).toContain(
      "A required check could not finish. Commit blocked.",
    );
    expect(frame).toContain("3 passed · 2 warnings · 1 failed");
    expect(frame).not.toContain("1 incomplete");
  });
});
