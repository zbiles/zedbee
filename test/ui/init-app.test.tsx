import { stripVTControlCharacters } from "node:util";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  CHECK_IDS,
  type CheckId,
  type ProfileId,
} from "../../src/config/schema.js";
import type { InitFileChange, InitProposal } from "../../src/init/types.js";
import {
  InitApp,
  initMaxFps,
  initRenderOptions,
} from "../../src/ui/init-app.js";
import { pixelBeeWidth } from "../../src/ui/pixel-bee.js";
import { pixelWordmarkWidth } from "../../src/ui/pixel-wordmark.js";

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

const DEFAULT_TEST_ROWS = 120;
const SHORT_TERMINAL = Object.freeze({ columns: 109, rows: 20 });

function setupFrame(
  value: InitProposal,
  width = 80,
  rows = DEFAULT_TEST_ROWS,
): string {
  return render(
    <InitApp
      proposal={value}
      proposalForSelection={() => value}
      width={width}
      terminalSize={{ columns: width, rows }}
      color={false}
      animations={false}
      onDecision={() => undefined}
    />,
  ).lastFrame()!;
}

function renderedLines(frame: string): readonly string[] {
  return stripVTControlCharacters(frame).split("\n");
}

function visibleContentLines(frame: string): readonly string[] {
  return renderedLines(frame).slice(1, -1);
}

function expectScrolledDownBy(
  before: string,
  after: string,
  rowCount: number,
): void {
  const beforeRows = visibleContentLines(before);
  const afterRows = visibleContentLines(after);
  expect(afterRows.slice(0, -rowCount)).toEqual(beforeRows.slice(rowCount));
}

async function settleInput(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function fileChange(
  relativePath: string,
  before: string | null,
): InitFileChange {
  return {
    relativePath,
    before,
    after: "updated contents",
    beforeHash: before === null ? null : "before-hash",
    afterHash: "after-hash",
    diff: `DO NOT SHOW DIFF FOR ${relativePath}`,
    mode: 0o644,
  };
}

function scrollableReviewProposal(): InitProposal {
  return {
    ...proposal,
    files: [
      fileChange(".zedbeerc.jsonc", null),
      fileChange("package.json", "existing manifest"),
      fileChange(".git/hooks/pre-commit", null),
    ],
  };
}

describe("InitApp", () => {
  it("clips the whole branded setup frame to a short live terminal", async () => {
    const view = render(
      <InitApp
        proposal={proposal}
        proposalForSelection={() => proposal}
        width={80}
        terminalSize={SHORT_TERMINAL}
        color={false}
        animations={false}
        onDecision={() => undefined}
      />,
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain("↓ MORE BELOW"));
    const frame = view.lastFrame()!;
    const lines = renderedLines(frame);

    expect(lines).toHaveLength(20);
    expect(frame).toContain("▀▀▀▀█ █▀▀▀▀");
    expect(frame).toContain("➜ Profile:");
    expect(frame).not.toContain("CHECKS");
    expect(frame).not.toContain("VULNERABILITY SERVICE OUTAGES");
    expect(frame).not.toContain("REVIEW CHANGES");
    expect(
      Math.max(...lines.map((line) => [...line].length)),
    ).toBeLessThanOrEqual(109);
  });

  it("reveals a newly focused setup row only after it crosses the viewport edge", async () => {
    const view = render(
      <InitApp
        proposal={proposal}
        proposalForSelection={() => proposal}
        width={80}
        terminalSize={SHORT_TERMINAL}
        color={false}
        animations={false}
        onDecision={() => undefined}
      />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↓ MORE BELOW"));

    view.stdin.write("\u001b[<65;20;8M");
    view.stdin.write("\u001b[<65;20;8M");
    await vi.waitFor(() =>
      expect(visibleContentLines(view.lastFrame()!)[0]).toContain("█▀▀▀▀"),
    );
    const manuallyScrolledTop = visibleContentLines(view.lastFrame()!)[0];

    view.stdin.write("\u001b[B");
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain("➜ [✽] formatting"),
    );
    expect(visibleContentLines(view.lastFrame()!)[0]).toBe(manuallyScrolledTop);

    view.stdin.write("\u001b[B");
    view.stdin.write("\u001b[B");
    await settleInput();
    expect(visibleContentLines(view.lastFrame()!)[0]).toBe(manuallyScrolledTop);

    view.stdin.write("\u001b[B");
    await vi.waitFor(() =>
      expect(visibleContentLines(view.lastFrame()!).at(-1)).toContain(
        "➜ [ ] cyclomaticComplexity",
      ),
    );
    expect(visibleContentLines(view.lastFrame()!)[0]).not.toBe(
      manuallyScrolledTop,
    );

    const clippedRevealTop = visibleContentLines(view.lastFrame()!)[0];
    view.stdin.write("\u001b[A");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("➜ [✽] types"));
    expect(visibleContentLines(view.lastFrame()!)[0]).toBe(clippedRevealTop);
  });

  it("minimally reveals a clipped setup target above the viewport", async () => {
    const view = render(
      <InitApp
        proposal={proposal}
        proposalForSelection={() => proposal}
        width={80}
        terminalSize={SHORT_TERMINAL}
        color={false}
        animations={false}
        onDecision={() => undefined}
      />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↓ MORE BELOW"));

    for (let index = 0; index < CHECK_IDS.length; index += 1) {
      view.stdin.write("\u001b[B");
    }
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain("➜ [ ] vulnerabilities"),
    );
    const lowerTop = visibleContentLines(view.lastFrame()!)[0];

    for (let index = 0; index < CHECK_IDS.length - 1; index += 1) {
      view.stdin.write("\u001b[A");
    }
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain("➜ [✽] formatting"),
    );
    expect(visibleContentLines(view.lastFrame()!)[0]).toBe(lowerTop);

    view.stdin.write("\u001b[A");
    await vi.waitFor(() =>
      expect(visibleContentLines(view.lastFrame()!)[0]).toContain("➜ Profile:"),
    );
  });

  it("reveals Profile when setup focus wraps from the last control", async () => {
    const view = render(
      <InitApp
        proposal={proposal}
        proposalForSelection={() => proposal}
        width={80}
        terminalSize={SHORT_TERMINAL}
        color={false}
        animations={false}
        onDecision={() => undefined}
      />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↓ MORE BELOW"));

    for (let index = 0; index < CHECK_IDS.length + 3; index += 1) {
      view.stdin.write("\u001b[B");
    }
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↑ MORE ABOVE"));

    view.stdin.write("\u001b[B");
    await vi.waitFor(() =>
      expect(visibleContentLines(view.lastFrame()!)[0]).toContain("➜ Profile:"),
    );
  });

  it("scrolls Review by rows and pages while restoring each phase offset", async () => {
    const reviewProposal = scrollableReviewProposal();
    const view = render(
      <InitApp
        proposal={reviewProposal}
        proposalForSelection={() => reviewProposal}
        width={80}
        terminalSize={SHORT_TERMINAL}
        color={false}
        animations={false}
        onDecision={() => undefined}
      />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↓ MORE BELOW"));

    view.stdin.write("\u001b[6~");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↑ MORE ABOVE"));
    const setupScrolled = view.lastFrame()!;

    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("REVIEW CHANGES");
      expect(view.lastFrame()).not.toContain("↑ MORE ABOVE");
    });
    const reviewTop = view.lastFrame()!;
    expect(reviewTop).toContain("▀▀▀▀█ █▀▀▀▀");

    view.stdin.write("\u001b[B");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↑ MORE ABOVE"));
    expectScrolledDownBy(reviewTop, view.lastFrame()!, 1);

    view.stdin.write("\u001b[A");
    await vi.waitFor(() => expect(view.lastFrame()).toBe(reviewTop));

    view.stdin.write("\u001b[6~");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↑ MORE ABOVE"));
    expectScrolledDownBy(reviewTop, view.lastFrame()!, 16);

    view.stdin.write("\u001b[5~");
    await vi.waitFor(() => expect(view.lastFrame()).toBe(reviewTop));

    view.stdin.write("\u001b[B");
    view.stdin.write("\u001b[B");
    view.stdin.write("\u001b[B");
    await settleInput();
    const reviewScrolled = view.lastFrame()!;
    expectScrolledDownBy(reviewTop, reviewScrolled, 3);

    view.stdin.write("\u001b");
    await vi.waitFor(() => expect(view.lastFrame()).toBe(setupScrolled));

    view.stdin.write("\r");
    await vi.waitFor(() => expect(view.lastFrame()).toBe(reviewScrolled));
  });

  it.each([
    ["Space", " "],
    ["Enter", "\r"],
    ["Y", "y"],
  ])("applies with %s from a scrolled Review", async (_label, input) => {
    const reviewProposal = scrollableReviewProposal();
    const onDecision = vi.fn();
    const view = render(
      <InitApp
        proposal={reviewProposal}
        proposalForSelection={() => reviewProposal}
        width={80}
        terminalSize={SHORT_TERMINAL}
        color={false}
        animations={false}
        onDecision={onDecision}
      />,
    );

    view.stdin.write("\r");
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain("REVIEW CHANGES"),
    );
    view.stdin.write("\u001b[6~");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↑ MORE ABOVE"));
    view.stdin.write(input);
    await vi.waitFor(() =>
      expect(onDecision).toHaveBeenCalledWith(reviewProposal),
    );
  });

  it("keeps Review back and cancellation keys available while scrolled", async () => {
    const reviewProposal = scrollableReviewProposal();
    const onDecision = vi.fn();
    const view = render(
      <InitApp
        proposal={reviewProposal}
        proposalForSelection={() => reviewProposal}
        width={80}
        terminalSize={SHORT_TERMINAL}
        color={false}
        animations={false}
        onDecision={onDecision}
      />,
    );

    view.stdin.write("\r");
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain("REVIEW CHANGES"),
    );
    view.stdin.write("\u001b[6~");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↑ MORE ABOVE"));
    view.stdin.write("\u001b");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("SETUP"));
    expect(onDecision).not.toHaveBeenCalled();

    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("↑ MORE ABOVE");
      expect(view.lastFrame()).toContain("APPLY CHANGES");
    });
    view.stdin.write("n");
    await vi.waitFor(() => expect(onDecision).toHaveBeenCalledWith(false));
  });

  it("keeps setup Escape cancellation available after manual scrolling", async () => {
    const onDecision = vi.fn();
    const view = render(
      <InitApp
        proposal={proposal}
        proposalForSelection={() => proposal}
        width={80}
        terminalSize={SHORT_TERMINAL}
        color={false}
        animations={false}
        onDecision={onDecision}
      />,
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain("↓ MORE BELOW"));
    view.stdin.write("\u001b[6~");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↑ MORE ABOVE"));
    view.stdin.write("\u001b");
    await vi.waitFor(() => expect(onDecision).toHaveBeenCalledWith(false));
  });

  it("scrolls three rows per wheel report and ignores clicks", async () => {
    const reviewProposal = scrollableReviewProposal();
    const view = render(
      <InitApp
        proposal={reviewProposal}
        proposalForSelection={() => reviewProposal}
        width={80}
        terminalSize={SHORT_TERMINAL}
        color={false}
        animations={false}
        onDecision={() => undefined}
      />,
    );
    view.stdin.write("\r");
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain("REVIEW CHANGES"),
    );
    const reviewTop = view.lastFrame()!;

    view.stdin.write("\u001b[<65;20;8M");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↑ MORE ABOVE"));
    const wheelDown = view.lastFrame()!;
    expectScrolledDownBy(reviewTop, wheelDown, 3);

    view.stdin.write("\u001b[<0;20;8M");
    await settleInput();
    expect(view.lastFrame()).toBe(wheelDown);

    view.stdin.write("\u001b[<64;20;8M");
    await vi.waitFor(() => expect(view.lastFrame()).toBe(reviewTop));
  });

  it("clamps on a taller resize and uses the resized live width", async () => {
    const elementFor = (columns: number, rows: number) => (
      <InitApp
        proposal={proposal}
        proposalForSelection={() => proposal}
        width={80}
        terminalSize={{ columns, rows }}
        color={false}
        animations={false}
        onDecision={() => undefined}
      />
    );
    const view = render(elementFor(109, 20));
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↓ MORE BELOW"));

    for (let index = 0; index < CHECK_IDS.length + 3; index += 1) {
      view.stdin.write("\u001b[B");
    }
    await vi.waitFor(() => expect(view.lastFrame()).toContain("↑ MORE ABOVE"));
    for (let index = 0; index < 4; index += 1) {
      view.stdin.write("\u001b[6~");
    }
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("↑ MORE ABOVE");
      expect(view.lastFrame()).not.toContain("↓ MORE BELOW");
    });

    view.rerender(elementFor(109, 35));
    await vi.waitFor(() =>
      expect(renderedLines(view.lastFrame()!)).toHaveLength(35),
    );
    const resizedAtBottom = view.lastFrame()!;
    expect(resizedAtBottom).toContain("↑ MORE ABOVE");
    expect(resizedAtBottom).not.toContain("↓ MORE BELOW");

    const reference = render(elementFor(109, 35));
    await vi.waitFor(() =>
      expect(reference.lastFrame()).toContain("↓ MORE BELOW"),
    );
    for (let index = 0; index < CHECK_IDS.length + 3; index += 1) {
      reference.stdin.write("\u001b[B");
    }
    await vi.waitFor(() =>
      expect(reference.lastFrame()).toContain("↑ MORE ABOVE"),
    );
    reference.stdin.write("\u001b[6~");
    await vi.waitFor(() => {
      expect(reference.lastFrame()).toContain("↑ MORE ABOVE");
      expect(reference.lastFrame()).not.toContain("↓ MORE BELOW");
    });
    expect(resizedAtBottom).toBe(reference.lastFrame());

    view.rerender(elementFor(80, DEFAULT_TEST_ROWS));
    await vi.waitFor(() =>
      expect(renderedLines(view.lastFrame()!)).toHaveLength(DEFAULT_TEST_ROWS),
    );
    const narrowFrame = view.lastFrame()!;
    expect(narrowFrame).toContain("▀▀▀▀█ █▀▀▀▀");
    expect(
      Math.max(...renderedLines(narrowFrame).map((line) => [...line].length)),
    ).toBeLessThanOrEqual(80);
  });

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
        terminalSize={{ columns: 80, rows: DEFAULT_TEST_ROWS }}
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

  it("opens and applies review through the focused action buttons", async () => {
    const onDecision = vi.fn();
    const view = render(
      <InitApp
        proposal={proposal}
        proposalForSelection={() => proposal}
        width={80}
        terminalSize={{ columns: 80, rows: DEFAULT_TEST_ROWS }}
        color={false}
        animations={false}
        onDecision={onDecision}
      />,
    );

    for (let index = 0; index < CHECK_IDS.length + 3; index += 1) {
      view.stdin.write("\u001b[B");
    }
    await new Promise((resolve) => setImmediate(resolve));
    view.stdin.write(" ");
    await new Promise((resolve) => setImmediate(resolve));

    expect(view.lastFrame()).toContain("REVIEW CHANGES");
    expect(view.lastFrame()).toContain("APPLY CHANGES");

    view.stdin.write(" ");
    await new Promise((resolve) => setImmediate(resolve));
    expect(onDecision).toHaveBeenCalledWith(proposal);
  });

  it("reviews concise file explanations without rendering raw diffs", async () => {
    const reviewProposal: InitProposal = {
      ...proposal,
      files: [
        fileChange(".zedbeerc.jsonc", null),
        fileChange(".git/hooks/pre-commit", "existing hook"),
        fileChange(".husky/pre-commit", null),
        fileChange("lefthook.yml", "existing config"),
        fileChange("package.json", "existing manifest"),
        fileChange("custom.txt", null),
      ],
    };
    const view = render(
      <InitApp
        proposal={reviewProposal}
        proposalForSelection={() => reviewProposal}
        width={80}
        terminalSize={{ columns: 80, rows: DEFAULT_TEST_ROWS }}
        color={false}
        animations={false}
        onDecision={() => undefined}
      />,
    );

    view.stdin.write("\r");
    await new Promise((resolve) => setImmediate(resolve));
    const frame = view.lastFrame()!;

    expect(frame).toContain("Review these changes before Zedbee saves them");
    expect(frame).toContain("Create Zedbee's repository configuration");
    expect(frame).toContain("Update the Git pre-commit hook");
    expect(frame).toContain("Create the Husky pre-commit hook");
    expect(frame).toContain("Update the Lefthook configuration");
    expect(frame).toContain("Update package.json so simple-git-hooks");
    expect(frame).toContain(
      "Create this file as part of Zedbee initialization",
    );
    expect(frame).not.toContain("DO NOT SHOW DIFF");
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
        terminalSize={{ columns: 80, rows: DEFAULT_TEST_ROWS }}
        color={false}
        animations={false}
        onDecision={onDecision}
      />,
    );

    expect(view.lastFrame()).toContain("▀▀▀▀█ █▀▀▀▀");
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
    expect(view.lastFrame()).toContain(
      "Create Zedbee's repository configuration",
    );
    expect(view.lastFrame()).not.toContain("exact:thorough:");
    expect(view.lastFrame()).toContain("Space/Enter/Y Apply");
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
        terminalSize={{ columns: 40, rows: DEFAULT_TEST_ROWS }}
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

  it("keeps the complete proportional brand visible at 109 columns", () => {
    const frame = setupFrame(proposal, 109);
    const lines = frame.split("\n");
    const panelTop = lines.findIndex((line) => line.includes("┌"));
    const wordmarkTop = lines.findIndex((line) => line.includes("▀▀▀▀█"));
    const wordmarkLeft = lines[wordmarkTop]!.indexOf("▀▀▀▀█");
    const wordmarkWidth = pixelWordmarkWidth(true);
    const beeLeft = wordmarkLeft + wordmarkWidth + 2;
    const beeWidth = pixelBeeWidth(true);
    const brandRows = lines
      .slice(0, panelTop)
      .map((line) => line.slice(wordmarkLeft, beeLeft + beeWidth))
      .filter((line) => !/^█+$/u.test(line));
    const occupiedBrandRows = brandRows.filter((line) => /[▀▄█]/u.test(line));
    const occupiedWordmarkRows = brandRows.filter((line) =>
      /[▀▄█]/u.test(line.slice(0, wordmarkWidth)),
    );
    const occupiedBeeRows = brandRows.filter((line) =>
      /[▀▄█]/u.test(line.slice(beeLeft - wordmarkLeft)),
    );

    expect(brandRows.some((line) => line.includes("▀"))).toBe(true);
    expect(panelTop).toBe(10);
    expect(occupiedBrandRows).toHaveLength(6);
    expect(occupiedWordmarkRows).toHaveLength(3);
    expect(occupiedBeeRows).toHaveLength(6);
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
