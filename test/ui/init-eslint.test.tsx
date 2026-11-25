import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { InitApp } from "../../src/ui/init-app.js";
import type { InitProposal } from "../../src/init/types.js";
import { waitForAssertion } from "../helpers/wait-for-assertion.js";
const base: InitProposal = {
  repositoryRoot: "/repo",
  profile: "recommended",
  hook: "none",
  hookActivation: { status: "not-requested", message: "No hooks requested." },
  detectedEnvironments: ["javascript"],
  recommendedChecks: ["lint"],
  vulnerabilityScanningAvailable: false,
  osvUnavailable: "block",
  networkChecks: [],
  limitations: [],
  files: [],
  eslintEngine: "managed",
};
describe("interactive ESLint setup", () => {
  it("requires separate execution consent and offers redacted messages by default", async () => {
    const onDecision = vi.fn();
    const view = render(
      <InitApp
        proposal={base}
        width={120}
        terminalSize={{ columns: 120, rows: 160 }}
        color={false}
        animations={false}
        onDecision={onDecision}
        proposalForSelection={(selection) => ({
          ...base,
          eslintEngine: selection.eslintEngine ?? "managed",
          projectEslintTrustConfirmed: selection.eslintTrust ?? false,
          projectEslintMessages: selection.eslintMessages ? "full" : "redacted",
          projectEslintMessagesConfirmed: selection.eslintMessageTrust ?? false,
        })}
      />,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("Use Zedbee's built-in ESLint");
    view.stdin.write("l");
    await waitForAssertion(() =>
      expect(view.lastFrame()).toContain("[✽] Use my project's ESLint"),
    );
    view.stdin.write("\r");
    await waitForAssertion(() =>
      expect(view.lastFrame()).not.toContain(
        "Review these changes before Zedbee saves",
      ),
    );
    view.stdin.write("x");
    await waitForAssertion(() =>
      expect(view.lastFrame()).toContain("[✽] Trust project ESLint execution"),
    );
    view.stdin.write("\r");
    await waitForAssertion(() =>
      expect(view.lastFrame()).toContain(
        "Review these changes before Zedbee saves",
      ),
    );
    view.stdin.write("\r");
    await waitForAssertion(() =>
      expect(onDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          eslintEngine: "project",
          projectEslintTrustConfirmed: true,
          projectEslintMessages: "redacted",
          projectEslintMessagesConfirmed: false,
        }),
      ),
    );
    view.unmount();
  });
});
