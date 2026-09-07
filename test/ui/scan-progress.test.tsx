import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  LiveDashboard,
  createScanProgress,
  updateScanProgress,
} from "../../src/ui/live-dashboard.js";
import { createFinding } from "../helpers/scan-report.js";

describe("bounded live progress", () => {
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
