import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  LiveDashboard,
  createScanProgress,
  updateScanProgress,
} from "../../src/ui/live-dashboard.js";
import { createFinding } from "../helpers/scan-report.js";

describe("bounded live progress", () => {
  it("shows startup immediately before any scan events arrive", () => {
    const progress = createScanProgress();
    const frame = render(
      <LiveDashboard
        progress={progress}
        startedAt={1000}
        elapsedMs={55500}
        width={120}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    expect(frame).toContain("Preparing scan");
    expect(frame).toContain("● Starting scan… (55.5s)");
    expect(frame).not.toContain("Step elapsed:");
    expect(progress.states.size).toBe(0);
  });

  it("shows the active preparation stage and its own elapsed time without creating checks", () => {
    const progress = createScanProgress();
    updateScanProgress(progress, {
      type: "scan-phase",
      checkId: "zedbee",
      target: ".",
      timestamp: 2000,
      phase: "snapshot-construction",
    });
    updateScanProgress(progress, {
      type: "scan-phase",
      checkId: "zedbee",
      target: ".",
      timestamp: 50000,
      phase: "target-inspection",
    });
    updateScanProgress(progress, {
      type: "git-soft-timeout",
      checkId: "zedbee",
      target: ".",
      timestamp: 52000,
    });
    const frame = render(
      <LiveDashboard
        progress={progress}
        startedAt={1000}
        elapsedMs={55500}
        width={120}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    expect(frame).toContain("● Inspecting changed project snapshot (6.5s)");
    expect(progress.states.size).toBe(0);
    expect(progress.activity.map(({ text }) => text)).toContain(
      "Building scan snapshots",
    );
  });

  it("cycles the active indicator beside the step while keeping its elapsed time inline", () => {
    const progress = createScanProgress([
      {
        type: "scan-phase",
        checkId: "zedbee",
        target: ".",
        timestamp: 1000,
        phase: "snapshot-construction",
      },
    ]);
    const view = render(
      <LiveDashboard
        progress={progress}
        startedAt={1000}
        elapsedMs={0}
        width={120}
        color={false}
        animations
      />,
    );
    expect(view.lastFrame()).toContain("⠋ Building scan snapshots (0.0s)");
    view.rerender(
      <LiveDashboard
        progress={progress}
        startedAt={1000}
        elapsedMs={80}
        width={120}
        color={false}
        animations
      />,
    );
    expect(view.lastFrame()).toContain("⠙ Building scan snapshots (0.1s)");
  });

  it("replaces preparation with real checks, then shows finalization alongside results", () => {
    const progress = createScanProgress();
    updateScanProgress(progress, {
      type: "scan-phase",
      checkId: "zedbee",
      target: ".",
      timestamp: 1,
      phase: "dispatch",
    });
    updateScanProgress(progress, {
      type: "check-running",
      checkId: "lint",
      target: ".",
      timestamp: 2,
    });
    const view = render(
      <LiveDashboard
        progress={progress}
        elapsedMs={10}
        width={120}
        color={false}
        animations={false}
      />,
    );
    expect(view.lastFrame()).not.toContain("Preparing scan");
    expect(view.lastFrame()).toContain("Lint");
    updateScanProgress(progress, {
      type: "scan-phase",
      checkId: "zedbee",
      target: ".",
      timestamp: 20,
      phase: "cleanup",
    });
    view.rerender(
      <LiveDashboard
        progress={progress}
        elapsedMs={30}
        width={120}
        color={false}
        animations={false}
      />,
    );
    expect(view.lastFrame()).toContain("Cleaning up scan resources");
    expect(progress.states.size).toBe(1);
  });

  it("retains first-seen order and running times without keeping completed finding payloads", () => {
    const progress = createScanProgress();
    updateScanProgress(progress, {
      type: "check-queued",
      checkId: "types",
      target: ".",
      timestamp: 0,
    });
    updateScanProgress(progress, {
      type: "check-running",
      checkId: "formatting",
      target: ".",
      timestamp: 100,
    });
    updateScanProgress(progress, {
      type: "check-completed",
      checkId: "types",
      target: ".",
      timestamp: 200,
      result: {
        checkId: "types",
        status: "completed",
        durationMs: 100,
        findings: [createFinding({ message: "fixture-secret-marker" })],
      },
    });
    const frame = render(
      <LiveDashboard
        progress={progress}
        elapsedMs={1100}
        width={120}
        color={false}
        animations={false}
      />,
    ).lastFrame()!;
    expect(frame.indexOf("Types")).toBeLessThan(frame.indexOf("Formatting"));
    expect(frame).toContain("running 1.0s");
    expect(frame).toContain("1 blocking finding");
    expect(JSON.stringify([...progress.states.values()])).not.toContain(
      "fixture-secret-marker",
    );
    expect(JSON.stringify(progress.activity)).not.toContain(
      "fixture-secret-marker",
    );
  });

  it("keeps the last six non-queued activities including network and Git warnings", () => {
    const progress = createScanProgress();
    for (let i = 0; i < 10; i++)
      updateScanProgress(progress, {
        type: "check-running",
        checkId: "lint",
        target: `target-${i}`,
        timestamp: i,
      });
    updateScanProgress(progress, {
      type: "network-disclosure",
      checkId: "vulnerabilities",
      target: ".",
      timestamp: 11,
      services: ["OSV"],
      metadata: ["versions"],
    });
    updateScanProgress(progress, {
      type: "git-soft-timeout",
      checkId: "zedbee",
      target: ".",
      timestamp: 12,
    });
    updateScanProgress(progress, {
      type: "check-queued",
      checkId: "types",
      target: ".",
      timestamp: 13,
    });
    expect(progress.states.size).toBe(11);
    expect(progress.activity).toHaveLength(6);
    expect(progress.activity.map((entry) => entry.text)).toEqual([
      "Lint · target-6: checking…",
      "Lint · target-7: checking…",
      "Lint · target-8: checking…",
      "Lint · target-9: checking…",
      "Vulnerabilities: online metadata → OSV",
      "Zedbee: Git command is still running after the configured soft timeout",
    ]);
  });
});
