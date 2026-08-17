import { renderToString } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ScanEvent } from "../../src/checks/events.js";
import {
  checkLabel,
  findingCheckLabel,
} from "../../src/reporting/check-label.js";
import { LiveDashboard } from "../../src/ui/live-dashboard.js";
import { createFinding } from "../helpers/scan-report.js";

function maxLineWidth(frame: string): number {
  return Math.max(...frame.split("\n").map((line) => [...line].length));
}

const events: ScanEvent[] = [
  { type: "check-queued", checkId: "formatting", target: ".", timestamp: 1 },
  { type: "check-running", checkId: "formatting", target: ".", timestamp: 2 },
  {
    type: "check-completed",
    checkId: "formatting",
    target: ".",
    timestamp: 5,
    result: {
      checkId: "formatting",
      status: "completed",
      durationMs: 3,
      findings: [],
    },
  },
  { type: "check-queued", checkId: "types", target: ".", timestamp: 3 },
  { type: "check-running", checkId: "types", target: ".", timestamp: 4 },
  { type: "check-queued", checkId: "secrets", target: ".", timestamp: 5 },
];

describe("LiveDashboard", () => {
  it("keeps friendly live labels separate from final engine labels", () => {
    expect(checkLabel("formatting")).toBe("Formatting");
    expect(checkLabel("lint")).toBe("Lint");
    expect(checkLabel("secrets")).toBe("Secrets");
    expect(checkLabel("vulnerabilities")).toBe("Vulnerabilities");
    expect(findingCheckLabel("formatting")).toBe("Prettier");
    expect(findingCheckLabel("lint")).toBe("ESLint");
    expect(findingCheckLabel("cyclomaticComplexity")).toBe("ESLint");
    expect(findingCheckLabel("readabilityComplexity")).toBe("ESLint");
    expect(findingCheckLabel("secrets")).toBe("Gitleaks");
    expect(findingCheckLabel("vulnerabilities")).toBe("OSV Scanner");
  });

  it("aligns the bee's stinger with the wordmark middle while its wings cross the rounded frame", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={18}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    const lines = frame.split("\n");
    const outerTop = lines.findIndex((line) => line.includes("╭"));
    const firstWing = lines.findIndex((line) => line.includes("██  ██"));
    const alignedStinger = lines.find(
      (line) =>
        line.includes("█████ ████  █   █ ████  ████  ████") &&
        line.includes("██████████ ████  ████  ████"),
    );

    expect(outerTop).toBeGreaterThan(0);
    expect(firstWing).toBeGreaterThanOrEqual(0);
    expect(firstWing).toBeLessThan(outerTop);
    expect(lines[outerTop]).toMatch(/^╭─+███─████─+╮$/u);
    expect(alignedStinger).toBeDefined();
  });

  it("connects heading rules to both panel strokes and spans their full width", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={18}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    const lines = frame.split("\n");
    const checksHeading = lines.findIndex(
      (line) => line.includes("CHECKS") && line.includes("ACTIVITY"),
    );
    const panelsTop = lines.find(
      (line) => line.includes("┌") && line.match(/┌/gu)?.length === 2,
    );
    const summaryHeading = lines.findIndex((line) => line.includes("SUMMARY"));
    const formattingRow = lines.findIndex((line) =>
      line.includes("Formatting"),
    );

    expect(checksHeading).toBeGreaterThanOrEqual(0);
    expect(panelsTop).toBeDefined();
    expect(
      lines[checksHeading]!.indexOf("CHECKS") - panelsTop!.indexOf("┌"),
    ).toBe(3);
    expect(lines[checksHeading + 1]!.match(/├─{41}┤/gu)).toHaveLength(2);
    expect(summaryHeading).toBeGreaterThanOrEqual(0);
    expect(lines[summaryHeading + 1]).toMatch(/├─{41}┤/u);
    expect(formattingRow).toBeGreaterThanOrEqual(0);
    expect(lines[formattingRow + 1]).toMatch(/├─{41}┤/u);
  });

  it("optically aligns the wordmark one column inside the checks stroke", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={18}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    const lines = frame.split("\n");
    const outerTop = lines.find((line) => line.includes("╭"));
    const wordmarkTop = lines.find((line) => line.includes("█████ █████"));
    const panelsTop = lines.find(
      (line) => line.includes("┌") && line.match(/┌/gu)?.length === 2,
    );

    expect(outerTop).toBeDefined();
    expect(wordmarkTop).toBeDefined();
    expect(panelsTop).toBeDefined();
    expect(panelsTop!.indexOf("┌") - outerTop!.indexOf("╭")).toBe(3);
    expect(wordmarkTop!.indexOf("█")).toBe(panelsTop!.indexOf("┌") + 1);
  });

  it("uses visually equal horizontal and vertical panel gaps", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={18}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    const lines = frame.split("\n");
    const panelsTop = lines.find((line) => /┐ {2}┌/u.test(line));
    const activityBottom = lines.findIndex(
      (line) => line.match(/└/gu)?.length === 1 && line.includes("┘"),
    );
    const summaryTop = lines.findIndex(
      (line, index) => index > activityBottom && line.includes("┌"),
    );

    expect(panelsTop).toBeDefined();
    expect(activityBottom).toBeGreaterThanOrEqual(0);
    expect(summaryTop - activityBottom).toBe(1);
  });

  it("uses a half-cell progress track as wide as the complete chip row", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={18}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    const progressLine = frame.split("\n").find((line) => line.includes("▄"));

    expect(progressLine).toBeDefined();
    expect(progressLine).toMatch(/▄{12}▂{25}/u);
    expect(progressLine!.match(/[▄▂]/gu)).toHaveLength(37);
    expect(progressLine).not.toContain("━");
    expect(progressLine).not.toContain("█");
    expect("▄").not.toBe("▂");
  });

  it.each([
    {
      width: 88,
      summaryLeft: 44,
      summaryRight: 82,
      groupFirst: 47,
      groupLast: 79,
      progress: "▄".repeat(11) + "▂".repeat(22),
      chips: [
        [47, 57, "  1 pass   "],
        [59, 68, "  0 warn  "],
        [70, 79, "  0 fail  "],
      ] as const,
    },
    {
      width: 96,
      summaryLeft: 48,
      summaryRight: 90,
      groupFirst: 51,
      groupLast: 87,
      progress: "▄".repeat(12) + "▂".repeat(25),
      chips: [
        [51, 62, "   1 pass   "],
        [64, 75, "   0 warn   "],
        [77, 87, "  0 fail   "],
      ] as const,
    },
    {
      width: 120,
      summaryLeft: 60,
      summaryRight: 114,
      groupFirst: 63,
      groupLast: 111,
      progress: "▄".repeat(16) + "▂".repeat(33),
      chips: [
        [63, 78, "     1 pass     "],
        [80, 95, "     0 warn     "],
        [97, 111, "    0 fail     "],
      ] as const,
    },
  ])(
    "right-aligns elapsed, progress, and two-row chips at width $width",
    ({
      width,
      summaryLeft,
      summaryRight,
      groupFirst,
      groupLast,
      progress,
      chips,
    }) => {
      const frame = renderToString(
        <LiveDashboard
          events={events}
          startedAt={0}
          elapsedMs={2800}
          width={width}
          color={false}
          animations={false}
        />,
        { columns: width },
      );
      const lines = frame.split("\n");
      const elapsedRow = lines.find((line) => line.includes("elapsed"));
      const progressRowIndex = lines.findIndex((line) => line.includes("▄"));
      const progressRow = lines[progressRowIndex]!;
      const chipRowIndex = lines.findIndex(
        (line) =>
          line.includes("1 pass") &&
          line.includes("0 warn") &&
          line.includes("0 fail"),
      );
      const chipRow = lines[chipRowIndex]!;
      const summaryBottom = lines.findIndex(
        (line, index) => index > chipRowIndex && line.lastIndexOf("┘") >= 0,
      );

      expect(elapsedRow).toBeDefined();
      expect(elapsedRow!.indexOf("elapsed") + 6).toBe(groupLast);
      expect(progressRow.indexOf(progress)).toBe(groupFirst);
      expect(progressRow.indexOf(progress) + progress.length - 1).toBe(
        groupLast,
      );
      expect(progressRow[summaryLeft]).toBe("│");
      expect(progressRow[summaryRight]).toBe("│");
      expect(groupFirst - summaryLeft - 1).toBe(2);
      expect(summaryRight - groupLast - 1).toBe(2);
      for (const [first, last, contents] of chips) {
        expect(chipRow.slice(first, last + 1)).toBe(contents);
      }
      expect(chipRowIndex - progressRowIndex).toBe(2);
      expect(
        lines[progressRowIndex + 1]!.slice(groupFirst, groupLast + 1),
      ).toBe(" ".repeat(groupLast - groupFirst + 1));
      expect(summaryBottom - chipRowIndex).toBe(2);
      expect(progress.length).toBe(
        chips.reduce((total, [first, last]) => total + last - first + 1, 0) + 2,
      );
    },
  );

  it("gives elapsed time a three-row pixel hierarchy on roomy terminals", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={2800}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(frame).toContain("▀▀█     █▀█");
    expect(frame).toContain("█▀▀     █▀█");
    expect(frame).toContain("▀▀▀  ▀  ▀▀▀s");
  });

  it("spaces the pixel clock below its heading and aligns elapsed to its bottom row", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={2800}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    const lines = frame.split("\n");
    const summaryHeading = lines.findIndex((line) => line.includes("SUMMARY"));
    const firstClockRow = lines.findIndex((line) => line.includes("▀▀█"));
    const lastClockRow = lines.findIndex((line) => line.includes("▀▀▀  ▀"));

    expect(summaryHeading).toBeGreaterThanOrEqual(0);
    expect(firstClockRow - summaryHeading).toBe(3);
    expect(lines[firstClockRow]).not.toContain("elapsed");
    expect(lines[lastClockRow]).toContain("elapsed");
  });

  it("anchors sparse activity at the bottom of its panel", () => {
    const frame = render(
      <LiveDashboard
        events={[
          {
            type: "check-running",
            checkId: "types",
            target: ".",
            timestamp: 0,
          },
        ]}
        startedAt={0}
        elapsedMs={100}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    const lines = frame.split("\n");
    const heading = lines.findIndex((line) => line.includes("ACTIVITY"));
    const activity = lines.findIndex((line) =>
      line.includes("TypeScript: checking…"),
    );

    expect(heading).toBeGreaterThanOrEqual(0);
    expect(activity - heading).toBeGreaterThanOrEqual(4);
  });

  it("shows labeled queued, running, and completed states plus recent activity", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={18}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(frame).toContain("█████ █████ ████");
    expect(frame).toContain("CHECKS");
    expect(frame).toContain("ACTIVITY");
    expect(frame).toContain("SUMMARY");
    expect(frame).toContain("Formatting");
    expect(frame).toMatch(/Formatting\s+pass/u);
    expect(frame).toContain("TypeScript");
    expect(frame).toMatch(/TypeScript\s+running 0\.0s/u);
    expect(frame).toContain("Secrets");
    expect(frame).toMatch(/Secrets\s+queued/u);
    expect(frame).toContain("1 pass");
    expect(frame).toContain("0 warn");
    expect(frame).toContain("0 fail");
    expect(frame).toContain("Formatting: passed");
  });

  it("centers each terminal status glyph in the same three-cell slot", () => {
    const statusEvents: ScanEvent[] = [
      {
        type: "check-completed",
        checkId: "formatting",
        target: ".",
        timestamp: 1,
        result: {
          checkId: "formatting",
          status: "completed",
          durationMs: 1,
          findings: [],
        },
      },
      {
        type: "check-completed",
        checkId: "lint",
        target: ".",
        timestamp: 2,
        result: {
          checkId: "lint",
          status: "completed",
          durationMs: 1,
          findings: [createFinding({ severity: "warning" })],
        },
      },
      {
        type: "check-completed",
        checkId: "types",
        target: ".",
        timestamp: 3,
        result: {
          checkId: "types",
          status: "completed",
          durationMs: 1,
          findings: [createFinding({ severity: "error" })],
        },
      },
      {
        type: "check-completed",
        checkId: "secrets",
        target: ".",
        timestamp: 4,
        result: {
          checkId: "secrets",
          status: "incomplete",
          durationMs: 1,
          findings: [],
        },
      },
      {
        type: "check-completed",
        checkId: "reactAccessibility",
        target: ".",
        timestamp: 5,
        result: {
          checkId: "reactAccessibility",
          status: "skipped",
          durationMs: 1,
          findings: [],
          skipReason: "No React source files found.",
        },
      },
    ];
    const frame = render(
      <LiveDashboard
        events={statusEvents}
        startedAt={0}
        elapsedMs={5}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    const lines = frame.split("\n");
    const panelsTop = lines.find(
      (line) => line.includes("┌") && line.match(/┌/gu)?.length === 2,
    );
    const checksStroke = panelsTop!.indexOf("┌");
    const activityStroke = panelsTop!.lastIndexOf("┌");
    const rows = [
      ["Formatting", "✓", "pass"],
      ["Lint", "!", "warn"],
      ["TypeScript", "×", "fail"],
      ["Secrets", "!", "incomplete"],
      ["React accessibility", "−", "skipped"],
    ] as const;

    expect(panelsTop).toBeDefined();
    for (const [label, glyph, status] of rows) {
      const row = lines.find((line) => {
        const checksCells = line.slice(checksStroke, activityStroke);
        return (
          checksCells.includes(label) &&
          new RegExp(`\\s${status}\\s+│`, "u").test(checksCells)
        );
      });
      expect(row).toBeDefined();
      expect(row!.slice(checksStroke + 3, checksStroke + 6)).toBe(` ${glyph} `);
      expect(row).toMatch(new RegExp(`${status}\\s*│`, "u"));
    }
    expect(frame).not.toContain("⚠");
  });

  it("stacks live panels at narrow widths without hiding state labels", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={18}
        width={60}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(frame).toContain("CHECKS");
    expect(frame).toContain("ACTIVITY");
    expect(frame).toContain("SUMMARY");
    expect(frame).toMatch(/TypeScript\s+running 0\.0s/u);
    expect(maxLineWidth(frame)).toBeLessThanOrEqual(60);
  });

  it("keeps every live row inside the padded outer frame", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={18}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    const lines = frame.split("\n");
    const outerTop = lines.findIndex((line) => line.includes("╭"));
    const outerBottom = lines.findIndex((line) => line.includes("╰"));
    const framedRows = lines.slice(outerTop + 1, outerBottom);

    expect(outerTop).toBeGreaterThanOrEqual(0);
    expect(outerBottom).toBeGreaterThan(outerTop);
    expect(framedRows).not.toHaveLength(0);
    expect(framedRows.every((line) => line.startsWith("│ "))).toBe(true);
    expect(framedRows.filter((line) => !line.endsWith(" │"))).toEqual([]);
  });

  it("tracks and displays separate targets for the same check", () => {
    const targetEvents: ScanEvent[] = [
      {
        type: "check-queued",
        checkId: "types",
        target: "apps/web",
        timestamp: 1,
      },
      {
        type: "check-running",
        checkId: "types",
        target: "apps/web",
        timestamp: 2,
      },
      {
        type: "check-queued",
        checkId: "types",
        target: "packages/core",
        timestamp: 3,
      },
      {
        type: "check-running",
        checkId: "types",
        target: "packages/core",
        timestamp: 4,
      },
    ];

    const frame = render(
      <LiveDashboard
        events={targetEvents}
        startedAt={0}
        elapsedMs={18}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(frame).toContain("TypeScript · apps/web");
    expect(frame).toContain("TypeScript · packages/core");
    expect(frame).toContain("0 pass");
    expect(frame.match(/checking…/g)).toHaveLength(2);
  });

  it("animates the running check and reports its live duration", () => {
    const runningEvents: ScanEvent[] = [
      {
        type: "check-queued",
        checkId: "types",
        target: ".",
        timestamp: 10,
      },
      {
        type: "check-running",
        checkId: "types",
        target: ".",
        timestamp: 20,
      },
    ];
    const frameAt100 = render(
      <LiveDashboard
        events={runningEvents}
        startedAt={0}
        elapsedMs={100}
        width={96}
        color={false}
        animations
      />,
    ).lastFrame()!;
    const frameAt180 = render(
      <LiveDashboard
        events={runningEvents}
        startedAt={0}
        elapsedMs={180}
        width={96}
        color={false}
        animations
      />,
    ).lastFrame()!;
    const spinnerAt100 = /([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]).*TypeScript.*0\.1s/u;
    const spinnerAt180 = /([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]).*TypeScript.*0\.2s/u;

    expect(frameAt100).toMatch(spinnerAt100);
    expect(frameAt180).toMatch(spinnerAt180);
    expect(frameAt100.match(spinnerAt100)?.[1]).not.toBe(
      frameAt180.match(spinnerAt180)?.[1],
    );
  });

  it("keeps incomplete checks distinct from warnings in the live summary", () => {
    const incompleteEvents: ScanEvent[] = [
      {
        type: "check-queued",
        checkId: "secrets",
        target: ".",
        timestamp: 1,
      },
      {
        type: "check-running",
        checkId: "secrets",
        target: ".",
        timestamp: 2,
      },
      {
        type: "check-completed",
        checkId: "secrets",
        target: ".",
        timestamp: 3,
        result: {
          checkId: "secrets",
          status: "incomplete",
          durationMs: 1,
          findings: [],
        },
      },
    ];
    const frame = render(
      <LiveDashboard
        events={incompleteEvents}
        startedAt={0}
        elapsedMs={3}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(frame).toMatch(/Secrets\s+incomplete/u);
    expect(frame).toContain("0 warn");
    expect(frame).not.toContain("1 incomplete");
  });

  it("renders skipped checks neutrally and excludes them from outcome counters", () => {
    const skippedEvents: ScanEvent[] = [
      {
        type: "check-queued",
        checkId: "reactAccessibility",
        target: ".",
        timestamp: 1,
      },
      {
        type: "check-completed",
        checkId: "reactAccessibility",
        target: ".",
        timestamp: 2,
        result: {
          checkId: "reactAccessibility",
          status: "skipped",
          durationMs: 0,
          findings: [],
          skipReason: "No React source files found.",
        },
      },
    ];
    const frame = render(
      <LiveDashboard
        events={skippedEvents}
        startedAt={0}
        elapsedMs={2}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(frame).toMatch(/React accessibility\s+skipped/u);
    expect(frame).toContain("React accessibility: skipped");
    expect(frame).toContain("0 pass");
  });

  it("reports blocking and warning findings separately in activity", () => {
    const mixedEvents: ScanEvent[] = [
      {
        type: "check-completed",
        checkId: "lint",
        target: ".",
        timestamp: 2,
        result: {
          checkId: "lint",
          status: "completed",
          durationMs: 1,
          findings: [
            createFinding({ severity: "error" }),
            createFinding({ id: "finding-2", severity: "warning" }),
          ],
        },
      },
    ];
    const frame = render(
      <LiveDashboard
        events={mixedEvents}
        startedAt={0}
        elapsedMs={2}
        width={96}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(frame).toContain("Lint: 1 blocking · 1 warning");
  });

  it("keeps the live interface within a 40-column terminal", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={18}
        width={40}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(maxLineWidth(frame)).toBeLessThanOrEqual(40);
    expect(frame).toContain("CHECKS");
    expect(frame).toContain("SUMMARY");
  });

  it("uses a text brand and remains bounded at 20 columns", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        startedAt={0}
        elapsedMs={18}
        width={20}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(frame).toContain("ZEDBEE");
    expect(frame).toContain("0.0s");
    expect(maxLineWidth(frame)).toBeLessThanOrEqual(20);
  });

  it("preserves the complete centered status slot under narrow row pressure", () => {
    const frame = render(
      <LiveDashboard
        events={[
          {
            type: "check-completed",
            checkId: "reactAccessibility",
            target: ".",
            timestamp: 1,
            result: {
              checkId: "reactAccessibility",
              status: "skipped",
              durationMs: 0,
              findings: [],
              skipReason: "No React source files found.",
            },
          },
        ]}
        startedAt={0}
        elapsedMs={2800}
        width={20}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    const checkRow = frame.split("\n").find((line) => line.includes("−"));

    expect(checkRow).toBeDefined();
    expect(checkRow).toContain("│   − Re");
    expect(maxLineWidth(frame)).toBeLessThanOrEqual(20);
  });

  it("shows elapsed copy only when a separator cell also fits", () => {
    const renderAt = (width: number) =>
      render(
        <LiveDashboard
          events={[]}
          startedAt={0}
          elapsedMs={2800}
          width={width}
          color={false}
          animations={false}
        />,
      ).lastFrame()!;
    const compact = renderAt(24);
    const separated = renderAt(25);

    expect(compact).toContain("2.8s");
    expect(compact).not.toContain("2.8selapsed");
    expect(compact).not.toContain("elapsed");
    expect(separated).toContain("2.8s elapsed");
    expect(maxLineWidth(compact)).toBeLessThanOrEqual(24);
    expect(maxLineWidth(separated)).toBeLessThanOrEqual(25);
  });
});
