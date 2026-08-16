import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ScanEvent } from "../../src/checks/events.js";
import { LiveDashboard } from "../../src/ui/live-dashboard.js";

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
  it("shows labeled queued, running, and completed states plus recent activity", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        elapsedMs={18}
        width={120}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(frame).toContain("ZEDBEE");
    expect(frame).toContain("CHECKS");
    expect(frame).toContain("ACTIVITY");
    expect(frame).toContain("Formatting");
    expect(frame).toContain("PASS");
    expect(frame).toContain("TypeScript");
    expect(frame).toContain("RUNNING");
    expect(frame).toContain("Secrets");
    expect(frame).toContain("QUEUED");
    expect(frame).toContain("PROGRESS 1/3");
  });

  it("stacks live panels at narrow widths without hiding state labels", () => {
    const frame = render(
      <LiveDashboard
        events={events}
        elapsedMs={18}
        width={60}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(frame).toContain("CHECKS");
    expect(frame).toContain("ACTIVITY");
    expect(frame).toContain("RUNNING");
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
        elapsedMs={18}
        width={120}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;

    expect(frame).toContain("TypeScript · apps/web");
    expect(frame).toContain("TypeScript · packages/core");
    expect(frame).toContain("PROGRESS 0/2");
    expect(
      frame.match(/TypeScript · (?:apps\/web|packages\/core): running/g),
    ).toHaveLength(2);
  });
});
