import { afterEach, describe, expect, it, vi } from "vitest";

const originalForceColor = process.env.FORCE_COLOR;

afterEach(() => {
  if (originalForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = originalForceColor;
  }
  vi.doUnmock("../../src/ui/pixel-bee.js");
  vi.resetModules();
});

describe("PixelWordmark", () => {
  it("renders the compact wordmark as three proportional half-block rows", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { PixelWordmark, pixelWordmarkHeight } =
      await import("../../src/ui/pixel-wordmark.js");
    const frame = render(
      React.createElement(PixelWordmark, { color: false, compact: true }),
    ).lastFrame()!;
    const lines = frame.split("\n");

    expect(pixelWordmarkHeight(true)).toBe(3);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("█▀▀▀▀");
    expect(lines[2]).toContain("▀▀▀▀▀");
  });

  it("keeps the full-size wordmark at five rows with two-column pixels", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { PixelWordmark, pixelWordmarkHeight } =
      await import("../../src/ui/pixel-wordmark.js");
    const lines = render(React.createElement(PixelWordmark, { color: false }))
      .lastFrame()!
      .split("\n");

    expect(pixelWordmarkHeight(false)).toBe(5);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("██████████");
  });

  it("positions both compact shared-header bees from their reported height", async () => {
    vi.doMock("../../src/ui/pixel-bee.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../src/ui/pixel-bee.js")>();
      return {
        ...actual,
        pixelBeeHeight: (compact: boolean) =>
          actual.pixelBeeHeight(compact) - (compact ? 1 : 0),
      };
    });
    const React = await import("react");
    const { Text } = await import("ink");
    const { render } = await import("ink-testing-library");
    const { BrandedCommandFrame } =
      await import("../../src/ui/branded-command-frame.js");
    const { LiveDashboard } = await import("../../src/ui/live-dashboard.js");
    const { pixelBeeWidth } = await import("../../src/ui/pixel-bee.js");
    const { pixelWordmarkWidth } =
      await import("../../src/ui/pixel-wordmark.js");
    const renderedBeeOffset = (frame: string): number => {
      const lines = frame.split("\n");
      const wordmarkTop = lines.findIndex((line) => line.includes("▀▀▀▀█"));
      const wordmarkLeft = lines[wordmarkTop]!.indexOf("▀▀▀▀█");
      const beeLeft = wordmarkLeft + pixelWordmarkWidth(true) + 2;
      const beeWidth = pixelBeeWidth(true);
      const beeTop = lines.findIndex((line) => {
        const beeCells = line.slice(beeLeft, beeLeft + beeWidth);
        return /[▀▄█]/u.test(beeCells) && !/^█+$/u.test(beeCells);
      });
      return wordmarkTop - beeTop;
    };
    const commandFrame = render(
      React.createElement(BrandedCommandFrame, {
        width: 109,
        color: false,
        children: React.createElement(Text, null, "CONTENT"),
      }),
    ).lastFrame()!;
    const liveFrame = render(
      React.createElement(LiveDashboard, {
        events: [],
        startedAt: 0,
        elapsedMs: 0,
        width: 96,
        color: false,
        animations: false,
      }),
    ).lastFrame()!;

    expect([
      renderedBeeOffset(commandFrame),
      renderedBeeOffset(liveFrame),
    ]).toEqual([1, 1]);
  });

  it("applies the black live-dashboard surface behind the frame and brand", async () => {
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
        width: 96,
        color: true,
        animations: false,
      }),
    ).lastFrame()!;

    const lines = frame.split("\n");
    const visible = (line: string) => line.replaceAll(/\u001b\[[0-9;]*m/gu, "");
    const panelsTop = lines.findIndex((line) => visible(line).includes("┌"));
    const brandAndFrame = lines.slice(0, panelsTop).join("\n");

    expect(panelsTop).toBeGreaterThan(0);
    expect(brandAndFrame).toContain("\u001b[48;2;0;0;0m");
  });

  it("leaves the complete final report transparent to the terminal", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { ScanApp } = await import("../../src/ui/scan-app.js");
    const { createReport } = await import("../helpers/scan-report.js");
    const frame = render(
      React.createElement(ScanApp, {
        events: [],
        elapsedMs: 0,
        width: 96,
        color: true,
        animations: false,
        report: createReport(),
      }),
    ).lastFrame()!;

    expect(frame).not.toMatch(/\u001b\[48;/u);
  });

  it("renders check-row dividers with less contrast than panel and heading strokes", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { LiveDashboard } = await import("../../src/ui/live-dashboard.js");
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
            type: "check-running",
            checkId: "types",
            target: ".",
            timestamp: 2,
          },
        ],
        startedAt: 0,
        elapsedMs: 3,
        width: 96,
        color: true,
        animations: false,
      }),
    ).lastFrame()!;
    const lines = frame.split("\n");
    const visible = (line: string) => line.replaceAll(/\u001b\[[0-9;]*m/gu, "");
    const headingRule = lines.find((line) => visible(line).includes("├"));
    const formatting = lines.findIndex((line) =>
      visible(line).includes("Formatting"),
    );
    const checkRule = lines[formatting + 1];

    expect(headingRule).toContain("\u001b[38;2;72;78;89m");
    expect(checkRule).toContain("\u001b[38;2;50;54;62m");
  });

  it("renders panel headings as regular muted copy", async () => {
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
        width: 96,
        color: true,
        animations: false,
      }),
    ).lastFrame()!;
    const headingLine = frame
      .split("\n")
      .find((line) => line.includes("CHECKS") && line.includes("ACTIVITY"));

    expect(headingLine).toBeDefined();
    expect(headingLine).toContain("\u001b[38;2;101;108;120mCHECKS");
    expect(headingLine).toContain("\u001b[38;2;101;108;120mACTIVITY");
    expect(headingLine).not.toContain("\u001b[1m");
  });

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

  it("omits motion trails from the centered live bee", async () => {
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
        width: 96,
        color: true,
        animations: false,
      }),
    ).lastFrame()!;
    const visible = frame.replaceAll(/\u001b\[[0-9;]*m/gu, "");

    expect(visible).toContain("██████████");
    expect(visible).not.toContain("██████████ ████  ████  ████");
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

  it("colors Activity bullets by status while keeping their copy gray", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { LiveDashboard } = await import("../../src/ui/live-dashboard.js");
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
              findings: [
                {
                  id: "lint-warning",
                  check: "lint",
                  rule: "fixture",
                  severity: "warning",
                  message: "Fixture warning",
                  attribution: {
                    kind: "range-overlap",
                    staged: true,
                    evidence: [],
                  },
                },
              ],
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
    const passLine = frame
      .split("\n")
      .find((line) => line.includes("Formatting: passed"));
    const warningLine = frame
      .split("\n")
      .find((line) => line.includes("Lint: 1 finding"));

    expect(passLine).toContain("\u001b[38;2;85;207;130m■");
    expect(passLine).toContain("\u001b[38;2;146;152;165m Formatting: passed");
    expect(warningLine).toContain("\u001b[38;2;232;184;76m■");
    expect(warningLine).toContain("\u001b[38;2;146;152;165m Lint: 1 finding");
  });

  it("uses plain labels when filled summary chips are too narrow for pixel labels", async () => {
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
          line.includes("pass") &&
          line.includes("warn") &&
          line.includes("fail"),
      );

    expect(chipLine).toContain("\u001b[48;2;85;207;130m");
    expect(chipLine).toContain("\u001b[48;2;232;184;76m");
    expect(chipLine).toContain("\u001b[48;2;239;101;89m");
  });

  it("uses the quiet divider tone for the unfilled color progress track", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { LiveDashboard } = await import("../../src/ui/live-dashboard.js");
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
            type: "check-running",
            checkId: "types",
            target: ".",
            timestamp: 2,
          },
          {
            type: "check-queued",
            checkId: "secrets",
            target: ".",
            timestamp: 3,
          },
        ],
        startedAt: 0,
        elapsedMs: 3,
        width: 96,
        color: true,
        animations: false,
      }),
    ).lastFrame()!;
    const progressLine = frame.split("\n").find((line) => {
      const visible = line.replaceAll(/\u001b\[[0-9;]*m/gu, "");
      return /▄{10,}/u.test(visible);
    });

    expect(progressLine).toBeDefined();
    expect(progressLine).toContain("\u001b[38;2;50;54;62m");
  });
});
