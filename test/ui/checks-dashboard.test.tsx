import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckDescription } from "../../src/commands/checks.js";

const originalForceColor = process.env.FORCE_COLOR;

afterEach(() => {
  if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalForceColor;
  vi.resetModules();
});

beforeEach(() => {
  process.env.FORCE_COLOR = "3";
  vi.resetModules();
});

const checks: readonly CheckDescription[] = [
  {
    id: "formatting",
    description: "Checks staged formatting.",
    severity: "error",
    timing: "relevant",
    applicability: "applicable",
    targets: ["."],
    executionClass: "lightweight",
    network: "none",
    engine: { name: "Prettier", version: "3.9.6", license: "MIT" },
    limitation: "Reports differences without rewriting the index.",
  },
  {
    id: "reactAccessibility",
    description: "Checks JSX accessibility.",
    severity: "warn",
    timing: "relevant",
    applicability: "not-applicable",
    targets: [],
    executionClass: "lightweight",
    network: "none",
    engine: { name: "jsx-a11y", version: "6.10.2", license: "MIT" },
    limitation: "Static rules cannot prove runtime accessibility.",
    reason: "No React DOM workspace was found.",
  },
];

describe("ChecksDashboard", () => {
  it("renders one branded Checks panel with severity and applicability", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { ChecksDashboard } =
      await import("../../src/ui/checks-dashboard.js");
    const frame = render(
      React.createElement(ChecksDashboard, {
        width: 100,
        color: true,
        checks,
      }),
    ).lastFrame()!;

    expect(frame.match(/CHECKS/gu)).toHaveLength(1);
    expect(frame).toContain("formatting");
    expect(frame).toContain("SEVERITY: ERROR");
    expect(frame).toContain("APPLICABLE");
    expect(frame).toContain("reactAccessibility");
    expect(frame).toContain("SEVERITY: WARN");
    expect(frame).toContain("NOT APPLICABLE");
    expect(frame).toContain("Engine: Prettier 3.9.6 (MIT)");
    expect(frame).toContain("Reason: No React DOM workspace was found.");
    expect(frame).toContain("\u001b[38;2;254;205;35m");
    expect(
      Math.max(
        ...frame
          .replaceAll(/\u001b\[[0-9;]*m/gu, "")
          .split("\n")
          .map((line) => [...line].length),
      ),
    ).toBeLessThanOrEqual(100);
  });

  it("appends the completed dashboard without clearing terminal history", async () => {
    const output: string[] = [];
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "rows", {
      configurable: true,
      value: 5,
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      output.push(String(args[0] ?? ""));
      const callback = args.find((value) => typeof value === "function");
      if (typeof callback === "function")
        queueMicrotask(() => (callback as (error: null) => void)(null));
      return true;
    }) as typeof process.stdout.write);

    try {
      const { runInkChecks } = await import("../../src/ui/checks-dashboard.js");
      await runInkChecks(checks, { width: 100, color: true });
    } finally {
      stdout.mockRestore();
      if (isTTY === undefined)
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, "isTTY", isTTY);
      if (rows === undefined) delete (process.stdout as { rows?: number }).rows;
      else Object.defineProperty(process.stdout, "rows", rows);
    }

    const rendered = output.join("");
    expect(rendered.match(/CHECKS/gu)).toHaveLength(1);
    expect(rendered).toContain("Checks staged formatting.");
    expect(rendered).not.toContain("\u001b[2J\u001b[3J\u001b[H");
  });
});
