import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { CheckId } from "../../src/config/schema.js";
import type { InitProposal } from "../../src/init/types.js";
import { InitApp } from "../../src/ui/init-app.js";

const proposal: InitProposal = {
  repositoryRoot: "/repo",
  profile: "recommended",
  hook: "none",
  detectedEnvironments: ["javascript", "typescript"],
  recommendedChecks: ["formatting", "lint", "types"],
  networkChecks: [],
  limitations: [],
  hookActivation: {
    status: "not-requested",
    message: "No pre-commit integration was requested.",
  },
  files: [],
};

describe("InitApp", () => {
  it("previews and returns the exact proposal rebuilt from toggled checks", async () => {
    const onDecision = vi.fn();
    const proposalForChecks = vi.fn((checks: readonly CheckId[]) => ({
      ...proposal,
      recommendedChecks: checks,
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
    })) as unknown as (checks: readonly CheckId[]) => InitProposal;
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

    expect(view.lastFrame()).toContain("Check toggles (Up/Down, Space)");
    expect(view.lastFrame()).toContain("[x] formatting");
    expect(view.lastFrame()).toContain("[Y/Enter] yes · [N/Esc] no");

    view.stdin.write(" ");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("exact:lint,types");
    view.stdin.write("y");
    await new Promise((resolve) => setImmediate(resolve));

    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        recommendedChecks: ["lint", "types"],
        files: [expect.objectContaining({ diff: "exact:lint,types" })],
      }),
    );
  });
});
