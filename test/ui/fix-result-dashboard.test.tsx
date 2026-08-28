import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixPlan, FixResult } from "../../src/fixes/types.js";

const plan: FixPlan = {
  schemaVersion: 1,
  target: "index",
  selectedChecks: ["formatting", "lint", "reactCorrectness"],
  exitCode: 1,
  checks: [
    {
      checkId: "formatting",
      status: "completed",
      fixes: 24,
      issues: [],
    },
    {
      checkId: "lint",
      status: "incomplete",
      fixes: 0,
      issues: [
        {
          code: "TYPED_LINT_ANALYSIS_FAILED",
          message: "Typed lint could not inspect every requested file.",
          path: ".claude/skills/example/remotion.config.ts",
          remediation: "Correct the TypeScript project setup and retry.",
        },
      ],
    },
    {
      checkId: "reactCorrectness",
      status: "not-applicable",
      fixes: 0,
      issues: [],
      reason: "No React renderer detected",
    },
  ],
  summary: { fixes: 24, files: 24, blocking: 435, warnings: 0, skipped: 0 },
  files: [],
  items: [],
};

const result: FixResult = {
  exitCode: 0,
  appliedFixes: 24,
  changedFiles: Array.from({ length: 24 }, (_, index) => `src/${index}.ts`),
  unchangedFiles: [],
  issues: [],
};

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

describe("FixResultDashboard", () => {
  it("keeps a partial apply result and verification guidance in a distilled branded frame", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { FixResultDashboard } =
      await import("../../src/ui/fix-result-dashboard.js");
    const frame = render(
      React.createElement(FixResultDashboard, {
        plan,
        result,
        width: 120,
        color: true,
      }),
    ).lastFrame()!;
    const plain = stripVTControlCharacters(frame);

    expect(plain).toContain("FIX RESULT");
    expect(plain).toContain("PARTIALLY APPLIED");
    expect(plain).toContain("Applied fixes");
    expect(plain).toContain("24");
    expect(plain).not.toContain("Plan findings");
    expect(plain).not.toContain("435 blocking · 0 warnings");
    expect(plain).not.toContain("CHECK STATUS");
    expect(plain).not.toContain(
      "Typed lint could not inspect every requested file.",
    );
    expect(plain).not.toContain("No files have been changed.");
    expect(plain).toContain("NEXT STEP");
    expect(plain).toContain(
      "Review Zedbee's changes, stage the ones you want to keep, then run zedbee scan to verify the updated",
    );
    expect(plain).toContain("staged code and identify remaining findings.");
    expect(frame).toContain("\u001b[38;2;254;205;35mzedbee scan");
  });

  it("retains apply-time issues and their remediation", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { FixResultDashboard } =
      await import("../../src/ui/fix-result-dashboard.js");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const frame = render(
      React.createElement(FixResultDashboard, {
        plan: { ...plan, exitCode: 0, checks: [] },
        result: {
          ...result,
          exitCode: 1,
          appliedFixes: 23,
          changedFiles: result.changedFiles.slice(0, 23),
          unchangedFiles: ["src/stale.ts"],
          issues: [
            {
              kind: "stale",
              file: "src/stale.ts",
              checkIds: ["lint"],
              message: "The working file changed after preview.",
              remediation: "Build a fresh fix plan and try again.",
            },
            {
              kind: "stale",
              file: "src/stale.ts",
              checkIds: ["reactCorrectness"],
              message: "A second planned fix also became stale.",
              remediation: "Refresh the plan before applying it.",
            },
          ],
        },
        width: 100,
        color: false,
      }),
    ).lastFrame()!;

    expect(frame).toContain("APPLICATION ISSUES");
    expect(frame).toContain("src/stale.ts");
    expect(frame).toContain("The working file changed after preview.");
    expect(frame).toContain("Build a fresh fix plan and try again.");
    expect(frame).toContain("A second planned fix also became stale.");
    expect(frame).toContain("Refresh the plan before applying it.");
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((value) => String(value).includes("same key")),
      ),
    ).toBe(false);
    consoleError.mockRestore();
  });

  it("explains when every planned fix is already present in the working tree", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { FixResultDashboard } =
      await import("../../src/ui/fix-result-dashboard.js");
    const frame = render(
      React.createElement(FixResultDashboard, {
        plan,
        result: {
          exitCode: 0,
          appliedFixes: 0,
          changedFiles: [],
          unchangedFiles: Array.from(
            { length: 24 },
            (_, index) => `src/${index}.ts`,
          ),
          issues: [],
        },
        width: 120,
        color: true,
      }),
    ).lastFrame()!;
    const plain = stripVTControlCharacters(frame);

    expect(plain).toContain("FIXES ALREADY PRESENT");
    expect(plain).not.toContain("FAILED");
    expect(plain).toContain("Already fixed files");
    expect(plain).toContain("24");
    expect(plain).toContain("Unresolved files");
    expect(plain).not.toContain("fixes found in plan");
    expect(plain).not.toContain("fixes available");
    expect(plain).toContain(
      "24 files already contain their planned fixes in the working tree.",
    );
    expect(plain).toContain(
      "Stage the files you want to keep before running zedbee scan.",
    );
    expect(plain).not.toContain("Plan findings");
    const unresolvedRow = plain
      .split("\n")
      .findIndex((line) => line.includes("Unresolved files"));
    const explanationRow = plain
      .split("\n")
      .findIndex((line) => line.includes("already contain their planned"));
    expect(unresolvedRow).toBeGreaterThanOrEqual(0);
    expect(explanationRow).toBe(unresolvedRow + 2);
    const commandOffset = frame.indexOf("zedbee scan");
    expect(commandOffset).toBeGreaterThanOrEqual(0);
    expect(frame.slice(commandOffset - 80, commandOffset)).toContain(
      "\u001b[38;2;243;244;246m",
    );
  });
});
