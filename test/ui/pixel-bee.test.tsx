import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalForceColor = process.env.FORCE_COLOR;

beforeEach(() => {
  process.env.FORCE_COLOR = "3";
  vi.resetModules();
});

afterEach(() => {
  if (originalForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = originalForceColor;
  }
  vi.resetModules();
});

describe("PixelBee", () => {
  it("renders the compact bee as six proportional half-block rows", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { PixelBee } = await import("../../src/ui/pixel-bee.js");
    const frame = render(
      React.createElement(PixelBee, { compact: true, color: false }),
    ).lastFrame()!;
    const lines = frame.split("\n");

    expect(lines).toHaveLength(6);
    expect(lines.map((line) => line.padEnd(10))).toEqual([
      "  ▄██ ▄██▄",
      "  ▀██ ███▀",
      " ▄▄█████▄ ",
      "█▀███████▀",
      "▀████████▀",
      "   ▀▀▀▀▀  ",
    ]);
  });

  it("keeps full-size bee geometry unchanged", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { PixelBee } = await import("../../src/ui/pixel-bee.js");
    const lines = render(React.createElement(PixelBee, { color: false }))
      .lastFrame()!
      .split("\n");

    expect(lines).toHaveLength(11);
    expect(lines[0]!.indexOf("██")).toBe(6);
  });

  it("compacts mirrored motion trails to the stinger half-row", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { PixelBee } = await import("../../src/ui/pixel-bee.js");
    const frame = render(
      React.createElement(PixelBee, {
        compact: true,
        mirrored: true,
        motion: true,
        color: false,
      }),
    ).lastFrame()!;
    const lines = frame.split("\n");

    expect(lines).toHaveLength(6);
    expect(lines[3]).toBe("▄▄▄▄  ▄▄▄▄  ▄▄▄▄ ▀███████▀█");
  });

  it("reports compact height for sparse header placement", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { PixelBee, pixelBeeHeight } =
      await import("../../src/ui/pixel-bee.js");
    expect(pixelBeeHeight(true)).toBe(6);
    expect(pixelBeeHeight(false)).toBe(11);
    const normal = render(
      React.createElement(PixelBee, {
        compact: true,
        color: true,
      }),
    ).lastFrame()!;
    const sparse = render(
      React.createElement(PixelBee, {
        compact: true,
        sparse: true,
        color: true,
      }),
    ).lastFrame()!;

    expect(sparse.split("\n")).toHaveLength(6);
    expect(sparse).toBe(normal);
  });

  it("uses foreground and background colors for mixed compact half-cells", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render: renderWithColor } = await import("ink-testing-library");
    const { PixelBee: ColoredPixelBee } =
      await import("../../src/ui/pixel-bee.js");
    const frame = renderWithColor(
      React.createElement(ColoredPixelBee, { compact: true, color: true }),
    ).lastFrame()!;

    const stinger = frame.split("\n")[3]!;

    expect(stinger.replaceAll(/\u001b\[[0-9;]*m/gu, "")).toBe("█▀███████▀");
    expect(stinger).toContain("\u001b[48;2;254;205;35m\u001b[38;2;46;46;46m▀");
    expect(frame).toContain("\u001b[38;2;254;205;35m");
    expect(frame).toContain("\u001b[38;2;243;244;246m");
    expect(frame).toContain("\u001b[38;2;46;46;46m");
  });
});
