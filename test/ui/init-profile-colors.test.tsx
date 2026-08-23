import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InitProposal } from "../../src/init/types.js";

const originalForceColor = process.env.FORCE_COLOR;

beforeEach(() => {
  process.env.FORCE_COLOR = "3";
  vi.resetModules();
});

afterEach(() => {
  if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalForceColor;
  vi.resetModules();
});

describe("InitApp profile colors", () => {
  it("renders the selected profile white and the others gray", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { InitApp } = await import("../../src/ui/init-app.js");
    const proposal: InitProposal = {
      repositoryRoot: "/repo",
      profile: "recommended",
      hook: "none",
      detectedEnvironments: ["javascript"],
      recommendedChecks: ["formatting"],
      vulnerabilityScanningAvailable: false,
      osvUnavailable: "block",
      networkChecks: [],
      limitations: [],
      hookActivation: {
        status: "not-requested",
        message: "No pre-commit integration was requested.",
      },
      files: [],
    };

    const view = render(
      React.createElement(InitApp, {
        proposal,
        proposalForSelection: () => proposal,
        width: 80,
        color: true,
        animations: false,
        onDecision: () => undefined,
      }),
    );
    const frame = view.frames.findLast((candidate) =>
      candidate.includes("recommended"),
    )!;

    const profileLine = frame
      .split("\n")
      .find((line) => line.includes("recommended"))!;
    expect(profileLine).toContain("\u001b[38;2;146;152;165mProfile:  fast");
    expect(profileLine).toContain("\u001b[38;2;231;233;239m  recommended");
    expect(profileLine).toContain("\u001b[38;2;146;152;165m  thorough");
  });
});
