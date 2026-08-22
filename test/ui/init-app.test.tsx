import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  CHECK_IDS,
  type CheckId,
  type ProfileId,
} from "../../src/config/schema.js";
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

function setupFrame(value: InitProposal, width = 80): string {
  return render(
    <InitApp
      proposal={value}
      proposalForSelection={() => value}
      width={width}
      color={false}
      animations={false}
      onDecision={() => undefined}
    />,
  ).lastFrame()!;
}

describe("InitApp", () => {
  it("aligns the profile description with the Profile label", () => {
    const lines = setupFrame(proposal).split("\n");
    const profileLine = lines.find((line) => line.includes("Profile:"))!;
    const descriptionLine = lines.find((line) =>
      line.includes("Balanced local checks"),
    )!;

    expect(descriptionLine.indexOf("Balanced")).toBe(
      profileLine.indexOf("Profile:"),
    );
  });

  it.each([40, 80])(
    "reserves the wrapped disclosure area at %i columns",
    (width) => {
      const withDisclosure: InitProposal = {
        ...proposal,
        networkChecks: [
          {
            id: "vulnerabilities",
            usesNetwork: true,
            onUnavailable: "block",
            disclosure:
              "Online vulnerability checks send package names, exact versions, and ecosystem identifiers to api.osv.dev; source code and file hashes are not sent.",
          },
        ],
      };
      const emptyLines = setupFrame(proposal, width).split("\n");
      const disclosureLines = setupFrame(withDisclosure, width).split("\n");
      const emptyOutage = emptyLines.findIndex((line) =>
        line.includes("Block the commit"),
      );
      const disclosureOutage = disclosureLines.findIndex((line) =>
        line.includes("Block the commit"),
      );
      const disclosureStart = disclosureLines.findIndex((line) =>
        line.includes("NETWORK DISCLOSURE:"),
      );

      expect(disclosureStart).toBeGreaterThan(0);
      expect(emptyOutage).toBeGreaterThan(0);
      expect(emptyOutage).toBe(disclosureOutage);
      expect(emptyLines[disclosureStart]).not.toContain("NETWORK DISCLOSURE:");
    },
  );

  it("moves between outage options before selecting either one", async () => {
    const view = render(
      <InitApp
        proposal={proposal}
        proposalForSelection={(profile, checks, osvUnavailable) => ({
          ...proposal,
          profile,
          recommendedChecks: checks ?? proposal.recommendedChecks,
          osvUnavailable,
        })}
        width={80}
        color={false}
        animations={false}
        onDecision={() => undefined}
      />,
    );

    for (let index = 0; index < CHECK_IDS.length + 1; index += 1) {
      view.stdin.write("\u001b[B");
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("➜ [✽] Block the commit (recommended)");

    view.stdin.write("\u001b[B");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("➜ [ ] Warn and allow the commit");

    view.stdin.write(" ");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("➜ [✽] Warn and allow the commit");
    expect(view.lastFrame()).toContain("[ ] Block the commit (recommended)");

    view.stdin.write("\u001b[A");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("➜ [ ] Block the commit (recommended)");

    view.stdin.write(" ");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("➜ [✽] Block the commit (recommended)");
    expect(view.lastFrame()).toContain("[ ] Warn and allow the commit");
  });

  it("navigates profiles, checks, and OSV with one keyboard flow", async () => {
    const onDecision = vi.fn();
    const proposalForSelection = vi.fn(
      (
        profile: ProfileId,
        checks: readonly CheckId[] | undefined,
        osvUnavailable: "block" | "warn",
      ) => ({
        ...proposal,
        profile,
        recommendedChecks:
          checks ??
          (profile === "fast"
            ? (["formatting", "lint"] as const)
            : profile === "recommended"
              ? (["formatting", "lint", "types"] as const)
              : ([
                  "formatting",
                  "lint",
                  "types",
                  "cyclomaticComplexity",
                  "readabilityComplexity",
                  "structuralSecurity",
                  "secrets",
                  "duplication",
                  "dependencyArchitecture",
                  "deadCode",
                  "reactCorrectness",
                  "reactAccessibility",
                  "vulnerabilities",
                ] as const)),
        osvUnavailable,
        networkChecks:
          profile === "thorough" || checks?.includes("vulnerabilities")
            ? [
                {
                  id: "vulnerabilities" as const,
                  usesNetwork: true,
                  onUnavailable: osvUnavailable,
                  disclosure:
                    "Online vulnerability checks send package names, exact versions, and ecosystem identifiers to api.osv.dev; source code and file hashes are not sent.",
                },
              ]
            : [],
        files: [
          {
            relativePath: ".zedbeerc.jsonc",
            before: null,
            after: `${profile}:${checks?.join(",") ?? "profile"}`,
            beforeHash: null,
            afterHash: "hash",
            diff: `exact:${profile}:${checks?.join(",") ?? "profile"}`,
            mode: 0o644,
          },
        ],
      }),
    ) as unknown as (
      profile: ProfileId,
      checks: readonly CheckId[] | undefined,
      osvUnavailable: "block" | "warn",
    ) => InitProposal;
    const view = render(
      <InitApp
        proposal={proposal}
        proposalForSelection={proposalForSelection}
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
    expect(view.lastFrame()).toContain("➜ Profile:");
    expect(view.lastFrame()).toContain("[✽] formatting");
    expect(view.lastFrame()).toContain("VULNERABILITY SERVICE OUTAGES");
    expect(view.lastFrame()).toContain(
      "What should Zedbee do if OSV cannot be reached?",
    );
    expect(view.lastFrame()).toContain("[✽] Block the commit (recommended)");
    expect(view.lastFrame()).toContain("[ ] Warn and allow the commit");
    expect(view.lastFrame()).toContain("Enter Review");
    expect(view.lastFrame()).not.toContain("B/W Outage behavior");
    expect(view.lastFrame()).not.toContain("exact:");

    view.stdin.write("\u001b[C");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("Profile:  fast  recommended  thorough");
    expect(view.lastFrame()).toContain("[✽] vulnerabilities");
    const disclosureLine = view
      .lastFrame()!
      .split("\n")
      .findIndex((line) => line.includes("NETWORK DISCLOSURE:"));
    const vulnerabilityLine = view
      .lastFrame()!
      .split("\n")
      .findIndex((line) => line.includes("[✽] vulnerabilities"));
    expect(disclosureLine).toBeGreaterThan(vulnerabilityLine + 1);

    view.stdin.write("\u001b[B");
    await new Promise((resolve) => setImmediate(resolve));
    view.stdin.write(" ");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("custom");
    expect(view.lastFrame()).toContain(
      "Custom checks based on the thorough profile.",
    );
    expect(view.lastFrame()).toContain("➜ [ ] formatting");
    for (let index = 0; index < 13; index += 1) {
      view.stdin.write("\u001b[B");
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("➜ [✽] Block the commit (recommended)");
    view.stdin.write("\u001b[B");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("➜ [ ] Warn and allow the commit");
    view.stdin.write(" ");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("➜ [✽] Warn and allow the commit");
    expect(view.lastFrame()).toContain("[ ] Block the commit (recommended)");
    view.stdin.write("\r");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("REVIEW CHANGES");
    expect(view.lastFrame()).toContain("exact:thorough:");
    expect(view.lastFrame()).toContain("Enter/Y Apply");
    expect(view.lastFrame()).not.toContain("[✽] formatting");
    view.stdin.write("b");
    await new Promise((resolve) => setImmediate(resolve));
    expect(view.lastFrame()).toContain("SETUP");
    expect(view.lastFrame()).not.toContain("exact:");
    view.stdin.write("\r");
    await new Promise((resolve) => setImmediate(resolve));
    view.stdin.write("y");
    await new Promise((resolve) => setImmediate(resolve));

    const decision = onDecision.mock.calls[0]?.[0] as InitProposal;
    expect(decision.profile).toBe("thorough");
    expect(decision.recommendedChecks).toHaveLength(12);
    expect(decision.recommendedChecks).not.toContain("formatting");
    expect(decision.recommendedChecks).toContain("vulnerabilities");
    expect(decision.osvUnavailable).toBe("warn");
  });

  it("keeps the branded setup panel inside a narrow terminal", () => {
    const view = render(
      <InitApp
        proposal={proposal}
        proposalForSelection={() => proposal}
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

  it("homes the temporary screen exactly once so setup starts at the top", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const options = initRenderOptions();

    options.onRender?.();
    options.onRender?.();

    expect(options).toMatchObject({ alternateScreen: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("\u001b[H");
    write.mockRestore();
  });
});
