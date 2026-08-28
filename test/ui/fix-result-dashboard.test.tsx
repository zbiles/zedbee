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
  it("keeps a partial apply result, check details, and verification guidance in the branded permanent frame", async () => {
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
    expect(plain).toContain("435 blocking · 0 warnings");
    expect(plain).toContain("CHECK STATUS");
    expect(plain).toContain("formatting");
    expect(plain).toContain("READY");
    expect(plain).toContain("lint");
    expect(plain).toContain("INCOMPLETE");
    expect(plain).toContain(
      "Typed lint could not inspect every requested file.",
    );
    expect(plain).toContain(".claude/skills/example/remotion.config.ts");
    expect(plain).toContain("Correct the TypeScript project setup and retry.");
    expect(plain).toContain("reactCorrectness");
    expect(plain).toContain("NOT APPLICABLE");
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
});
