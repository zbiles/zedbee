import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("DoctorDashboard", () => {
  it("uses Zedbee status colors within one full-width Doctor panel", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { DoctorDashboard } =
      await import("../../src/ui/doctor-dashboard.js");
    const frame = render(
      React.createElement(DoctorDashboard, {
        width: 100,
        color: true,
        diagnostics: [
          { id: "git", status: "pass", message: "Git is ready." },
          {
            id: "hook-state",
            status: "warning",
            message: "No hook is installed.",
          },
          { id: "node", status: "fail", message: "Node is too old." },
        ],
      }),
    ).lastFrame()!;

    expect(frame.match(/DOCTOR/gu)).toHaveLength(1);
    expect(frame).toContain("\u001b[38;2;85;207;130mPASS");
    expect(frame).toContain("\u001b[38;2;232;184;76mWARNING");
    expect(frame).toContain("\u001b[38;2;239;101;89mFAIL");
    expect(frame).toContain("\u001b[38;2;254;205;35m");
    expect(frame).toContain("▀▀▀▀█ █▀▀▀▀");
    expect(frame).toContain("\u001b[48;2;0;0;0m  \u001b[38;2;72;78;89m┌");
    expect(frame).toContain("\u001b[48;2;0;0;0m  \u001b[38;2;72;78;89m│");
    expect(frame).not.toContain(
      "\u001b[48;2;0;0;0m  \u001b[49m\u001b[38;2;72;78;89m┌",
    );
    expect(
      Math.max(
        ...frame
          .replaceAll(/\u001b\[[0-9;]*m/gu, "")
          .split("\n")
          .map((line) => [...line].length),
      ),
    ).toBeLessThanOrEqual(100);
  });

  it("keeps the shared frame within a narrow no-color viewport", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { DoctorDashboard } =
      await import("../../src/ui/doctor-dashboard.js");
    const frame = render(
      React.createElement(DoctorDashboard, {
        width: 40,
        color: false,
        diagnostics: [{ id: "git", status: "pass", message: "Git is ready." }],
      }),
    ).lastFrame()!;

    expect(frame).toContain("ZEDBEE");
    expect(frame).toContain(" SWARM");
    const brandRows = frame
      .split("\n")
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes("ZEDBEE") || line.includes(" SWARM"));
    expect(brandRows[1]!.index - brandRows[0]!.index).toBe(2);
    expect(frame).toContain("DOCTOR");
    expect(frame).not.toMatch(/\u001B\[(?:38|48);2;/u);
    const plainFrame = frame.replaceAll(/\u001b\[[0-9;]*m/gu, "");
    expect(
      Math.max(...plainFrame.split("\n").map((line) => [...line].length)),
    ).toBeLessThanOrEqual(40);
  });

  it("flushes the completed dashboard through a live Ink session", async () => {
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      output.push(String(args[0] ?? ""));
      const callback = args.find((value) => typeof value === "function");
      if (typeof callback === "function")
        queueMicrotask(callback as () => void);
      return true;
    }) as typeof process.stdout.write);

    try {
      const { runInkDoctor } = await import("../../src/ui/doctor-dashboard.js");
      await runInkDoctor(
        [{ id: "git", status: "pass", message: "Git is ready." }],
        { width: 100, color: true },
      );
    } finally {
      stdout.mockRestore();
    }

    const rendered = output.join("");
    expect(rendered).toContain("DOCTOR");
    expect(rendered).toContain("Git is ready.");
    expect(rendered).toContain("PASS");
  });
});
