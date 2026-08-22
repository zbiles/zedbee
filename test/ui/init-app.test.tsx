import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { CheckId } from "../../src/config/schema.js";
import type { InitProposal } from "../../src/init/types.js";
import {
  InitApp,
  initMaxFps,
  initRenderOptions,
} from "../../src/ui/init-app.js";

const proposal: InitProposal = {
  repositoryRoot: "/repo",
  profile: "recommended",
  hook: "raw",
  detectedEnvironments: ["javascript", "typescript"],
  recommendedChecks: ["formatting", "lint", "types"],
  vulnerabilityScanningAvailable: true,
  osvUnavailable: "block",
  networkChecks: [],
  limitations: [],
  hookActivation: {
    status: "active",
    message: "The proposed raw hook directly invokes Zedbee.",
  },
  files: [],
};

describe("InitApp", () => {
  it("configures first and reviews exact changes only after Enter", async () => {
    const onDecision = vi.fn();
    const proposalForChecks = vi.fn(
      (checks: readonly CheckId[], osvUnavailable: "block" | "warn") => ({
        ...proposal,
        recommendedChecks: checks,
        osvUnavailable,
        files: [
          {
            relativePath: ".zedbeerc.jsonc",
            before: null,
            after: checks.join(","),
            beforeHash: null,
            afterHash: "hash",
            diff: `exact:${checks.join(",")}`,
            mode: 0o644,
          },
        ],
      }),
    ) as unknown as (
      checks: readonly CheckId[],
      osvUnavailable: "block" | "warn",
    ) => InitProposal;
    const view = render(
      <InitApp
        proposal={proposal}
        proposalForChecks={proposalForChecks}
        width={80}
        color={false}
        animations={false}
        onDecision={onDecision}
      />,
    );

    expect(view.lastFrame()).toContain("█████ █████ ████");
    expect(view.lastFrame()).toContain("SETUP");
    expect(view.lastFrame()).toContain("Install pre-commit hook: Yes");
    expect(view.lastFrame()).toContain("Method: Git pre-commit hook");
    expect(view.lastFrame()).toContain("CHECKS");
    expect(view.lastFrame()).toContain("[x] formatting");
    expect(view.lastFrame()).toContain("VULNERABILITY SERVICE OUTAGES");
    expect(view.lastFrame()).toContain(
      "What should Zedbee do if OSV cannot be reached?",
    );
    expect(view.lastFrame()).toContain("Block the commit (recommended)");
    expect(view.lastFrame()).toContain("Warn and allow the commit");
    expect(view.lastFrame()).toContain("Enter Review");
    expect(view.lastFrame()).not.toContain("exact:");

    view.stdin.write(" ");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).not.toContain("exact:");
    view.stdin.write("w");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("● [W] Warn and allow the commit");
    view.stdin.write("\r");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("REVIEW CHANGES");
    expect(view.lastFrame()).toContain("exact:lint,types");
    expect(view.lastFrame()).toContain("Enter/Y Apply");
    expect(view.lastFrame()).not.toContain("[x] formatting");
    view.stdin.write("b");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("SETUP");
    expect(view.lastFrame()).not.toContain("exact:");
    view.stdin.write("\r");
    await new Promise((resolve) => setImmediate(resolve));
    view.stdin.write("y");
    await new Promise((resolve) => setImmediate(resolve));

    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        recommendedChecks: ["lint", "types"],
        osvUnavailable: "warn",
        files: [expect.objectContaining({ diff: "exact:lint,types" })],
      }),
    );
  });

  it("keeps the branded setup panel inside a narrow terminal", () => {
    const view = render(
      <InitApp
        proposal={proposal}
        proposalForChecks={() => proposal}
        width={40}
        color={false}
        animations={false}
        onDecision={() => undefined}
      />,
    );

    const frame = view.lastFrame()!;
    expect(frame).toContain("ZEDBEE");
    expect(frame).toContain("SETUP");
    expect(
      Math.max(...frame.split("\n").map((line) => [...line].length)),
    ).toBeLessThanOrEqual(40);
  });

  it("uses a responsive refresh rate for keyboard interaction", () => {
    expect(initMaxFps()).toBeGreaterThan(1);
  });

  it("uses a temporary screen so repainting preserves terminal history", () => {
    expect(initRenderOptions()).toMatchObject({ alternateScreen: true });
  });
});
