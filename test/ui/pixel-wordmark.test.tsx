import { afterEach, describe, expect, it, vi } from "vitest";

const originalForceColor = process.env.FORCE_COLOR;

afterEach(() => {
  if (originalForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = originalForceColor;
  }
  vi.resetModules();
});

describe("PixelWordmark", () => {
  it("renders the final mock's white mark instead of the retired purple iteration", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { PixelWordmark } = await import("../../src/ui/pixel-wordmark.js");

    const frame = render(
      React.createElement(PixelWordmark, { color: true }),
    ).lastFrame()!;

    expect(frame).toContain("\u001b[38;2;243;244;246m");
    expect(frame).not.toContain("\u001b[38;2;177;140;247m");
  });

  it("renders the live bee's motion trails in the final mock's white", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { LiveDashboard } = await import("../../src/ui/live-dashboard.js");

    const frame = render(
      React.createElement(LiveDashboard, {
        events: [],
        startedAt: 0,
        elapsedMs: 0,
        width: 132,
        color: true,
        animations: false,
      }),
    ).lastFrame()!;
    const trailLine = frame.split("\n").find((line) => {
      const visible = line.replaceAll(/\u001b\[[0-9;]*m/gu, "");
      return visible.includes(
        "████████████████████ ████████    ████████    ████████",
      );
    });

    expect(trailLine).toBeDefined();
    const cellColors = [
      ...trailLine!.matchAll(/\u001b\[38;2;(\d+;\d+;\d+)m██/gu),
    ].map((match) => match[1]);
    expect(cellColors.slice(-3)).toEqual([
      "243;244;246",
      "243;244;246",
      "243;244;246",
    ]);
  });

  it("uses the mock's green information color for running checks", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { LiveDashboard } = await import("../../src/ui/live-dashboard.js");

    const frame = render(
      React.createElement(LiveDashboard, {
        events: [
          {
            type: "check-running",
            checkId: "types",
            target: ".",
            timestamp: 0,
          },
        ],
        startedAt: 0,
        elapsedMs: 100,
        width: 96,
        color: true,
        animations: false,
      }),
    ).lastFrame()!;
    const checkLine = frame
      .split("\n")
      .find((line) => line.includes("TypeScript"));

    expect(checkLine).toContain("\u001b[38;2;85;207;130m");
  });

  it("renders pass, warn, and fail totals as filled summary chips", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { LiveDashboard } = await import("../../src/ui/live-dashboard.js");
    const finding = (severity: "warning" | "error") => ({
      id: `finding-${severity}`,
      check: "lint",
      rule: "fixture",
      severity,
      message: "Fixture finding",
      attribution: {
        kind: "range-overlap" as const,
        staged: true,
        evidence: [],
      },
    });

    const frame = render(
      React.createElement(LiveDashboard, {
        events: [
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
              findings: [finding("warning")],
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
              findings: [finding("error")],
            },
          },
        ],
        startedAt: 0,
        elapsedMs: 3,
        width: 96,
        color: true,
        animations: false,
      }),
    ).lastFrame()!;
    const chipLine = frame
      .split("\n")
      .find(
        (line) =>
          line.includes("1 pass") &&
          line.includes("1 warn") &&
          line.includes("1 fail"),
      );

    expect(chipLine).toContain("\u001b[48;2;85;207;130m");
    expect(chipLine).toContain("\u001b[48;2;232;184;76m");
    expect(chipLine).toContain("\u001b[48;2;239;101;89m");
  });
});
