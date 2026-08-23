import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckDescription } from "../../src/checks/description.js";

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
    configuration: {
      customized: true,
      values: {
        "settings.printWidth": {
          value: 100,
          source: "repository",
          customized: true,
        },
        "settings.tabWidth": {
          value: 2,
          source: "profile",
          customized: false,
        },
      },
      overrides: [
        {
          files: ["test/**"],
          values: { "settings.tabWidth": 4 },
        },
      ],
    },
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
    configuration: {
      customized: false,
      values: {},
      overrides: [],
    },
  },
];

const hostilePatterns = [
  "src/\u001b[31mred/**",
  "docs/line\nbreak/**",
  "ui/\u202ereversed/**",
  `long/${"segment-".repeat(80)}/**`,
  "extra/a/**",
  "extra/b/**",
  "extra/c/**",
];

const hostileChecks: readonly CheckDescription[] = [
  {
    ...checks[0]!,
    configuration: {
      customized: true,
      values: {
        "settings.printWidth": {
          value: `${"😀".repeat(140)}\u001b[31m${"tail".repeat(80)}`,
          source: "repository",
          customized: true,
        },
      },
      overrides: [
        {
          files: hostilePatterns,
          values: { "settings.tabWidth": 4 },
        },
        {
          files: ["repeat/**"],
          values: { "settings.semi": false },
        },
        {
          files: ["repeat/**"],
          values: { "settings.singleQuote": true },
        },
      ],
    },
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
    expect(frame).toContain(
      "Configuration: 1 profile value, 1 repository value",
    );
    expect(frame).toContain(
      "settings.printWidth: 100 (repository) (customized)",
    );
    expect(frame).toContain("Override test/**: settings.tabWidth: 4");
    expect(frame).toContain("Reason: No React DOM workspace was found.");
    expect(frame).toContain("\u001b[38;2;232;184;76m");
    expect(frame).toContain("\u001b[38;2;254;205;35m");
    expect(frame).toContain("▀▀▀▀█ █▀▀▀▀");
    expect(frame).toContain("┌");
    expect(frame).toContain("└");
    expect(
      Math.max(
        ...frame
          .replaceAll(/\u001b\[[0-9;]*m/gu, "")
          .split("\n")
          .map((line) => [...line].length),
      ),
    ).toBeLessThanOrEqual(100);
  });

  it("keeps the shared frame and content inside a narrow no-color viewport", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { ChecksDashboard } =
      await import("../../src/ui/checks-dashboard.js");
    const frame = render(
      React.createElement(ChecksDashboard, {
        width: 40,
        color: false,
        checks: checks.slice(0, 1),
      }),
    ).lastFrame()!;

    expect(frame).toContain("ZEDBEE");
    expect(frame).toContain("CHECKS");
    expect(frame).toContain("Configuration:");
    expect(frame).toContain("(customized)");
    expect(frame).not.toMatch(/\u001B\[(?:38|48);2;/u);
    const plainFrame = frame.replaceAll(/\u001b\[[0-9;]*m/gu, "");
    expect(
      Math.max(...plainFrame.split("\n").map((line) => [...line].length)),
    ).toBeLessThanOrEqual(40);
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
    expect(output).toHaveLength(1);
    expect(rendered.match(/CHECKS/gu)).toHaveLength(1);
    expect(rendered).toContain("Checks staged formatting.");
    expect(rendered).toContain(
      "settings.printWidth: 100 (repository) (customized)",
    );
    expect(rendered).not.toContain("\u001b[2J\u001b[3J\u001b[H");
  });

  it("escapes and bounds unsafe override patterns and values in the Ink terminal output", async () => {
    const output: string[] = [];
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "rows", {
      configurable: true,
      value: 8,
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
      await runInkChecks(hostileChecks, { width: 70, color: false });
    } finally {
      stdout.mockRestore();
      if (isTTY === undefined)
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, "isTTY", isTTY);
      if (rows === undefined) delete (process.stdout as { rows?: number }).rows;
      else Object.defineProperty(process.stdout, "rows", rows);
    }

    const rendered = output.join("");
    expect(rendered).toContain("src/\\u001b[31mred/**");
    expect(rendered).toContain("docs/line\\u000abreak/**");
    expect(rendered).toContain("ui/\\u202ereversed/**");
    expect(rendered).toContain("[truncated]");
    expect(rendered).toContain("(+4 patterns)");
    expect(rendered).not.toContain("\u001b[31m");
    expect(rendered).not.toContain("line\nbreak/**");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).not.toContain(hostilePatterns[3]);
    expect(rendered).not.toContain("\u001b[2J\u001b[3J\u001b[H");
    const plainFrame = rendered.replaceAll(/\u001b\[[0-9;]*m/gu, "");
    expect(
      Math.max(...plainFrame.split("\n").map((line) => [...line].length)),
    ).toBeLessThanOrEqual(70);
  });

  it("uses stable override row keys for repeated identical file patterns", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { ChecksDashboard } =
      await import("../../src/ui/checks-dashboard.js");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const frame = render(
        React.createElement(ChecksDashboard, {
          width: 100,
          color: false,
          checks: hostileChecks,
        }),
      ).lastFrame()!;

      expect(frame.match(/Override repeat\/\*\*/gu)).toHaveLength(2);
      expect(frame).toContain("settings.semi: false");
      expect(frame).toContain("settings.singleQuote: true");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
