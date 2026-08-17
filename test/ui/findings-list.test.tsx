import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFinding } from "../helpers/scan-report.js";

const originalForceColor = process.env.FORCE_COLOR;

function visible(value: string): string {
  return value.replaceAll(/\u001b\[[0-9;]*m/gu, "");
}

function maxVisibleWidth(frame: string): number {
  return Math.max(
    ...frame.split("\n").map((line) => [...visible(line)].length),
  );
}

function wideFinding() {
  return createFinding({
    check: "lint",
    rule: "no-unused-vars",
    message: "Variable is assigned but never used.",
    location: { file: "src/app.ts", startLine: 42, startColumn: 7 },
    remediation: "Remove it or use the value.",
    sourceExcerpt: {
      line: 42,
      text: "const unused = calculateValue()",
      redacted: false,
      truncated: false,
    },
  });
}

afterEach(() => {
  if (originalForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = originalForceColor;
  }
  vi.resetModules();
});

beforeEach(() => {
  process.env.FORCE_COLOR = "3";
  vi.resetModules();
});

describe("FindingsList", () => {
  it("renders the approved 96-column per-finding hierarchy", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { FindingsList } = await import("../../src/ui/findings-list.js");

    const frame = render(
      React.createElement(FindingsList, {
        findings: [wideFinding()],
        width: 96,
        color: false,
      }),
    ).lastFrame()!;
    const lines = frame.split("\n").map(visible);
    const header = lines.findIndex((line) => line.includes("no-unused-vars"));
    const source = lines.findIndex((line) => line.includes("calculateValue"));
    const issue = lines.findIndex((line) =>
      line.includes("Variable is assigned"),
    );
    const fix = lines.findIndex((line) => line.includes("Remove it or use"));

    expect(lines[header]!.indexOf("ESLint  no-unused-vars")).toBe(0);
    expect(lines[header]!.endsWith("src/app.ts:42")).toBe(true);
    expect(lines[source]).toContain("42 │ const unused = calculateValue()");
    expect(lines[issue]).toContain(
      "Issue: Variable is assigned but never used.",
    );
    expect(lines[fix]).toContain("Fix: Remove it or use the value.");
    expect(lines[source]!.indexOf("42 │")).toBe(3);
    expect(lines[issue]!.indexOf("Issue:")).toBe(3);
    expect(lines[fix]!.indexOf("Fix:")).toBe(3);
    expect(header).toBeLessThan(source);
    expect(source).toBeLessThan(issue);
    expect(issue).toBeLessThan(fix);
    expect(maxVisibleWidth(frame)).toBeLessThanOrEqual(96);
  });

  it("uses failure, secondary, and primary tones with bold Issue and Fix labels", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { FindingsList } = await import("../../src/ui/findings-list.js");

    const frame = render(
      React.createElement(FindingsList, {
        findings: [wideFinding()],
        width: 96,
        color: true,
      }),
    ).lastFrame()!;
    const lines = frame.split("\n");
    const header = lines.find((line) =>
      visible(line).includes("no-unused-vars"),
    )!;
    const source = lines.find((line) =>
      visible(line).includes("calculateValue"),
    )!;
    const issue = lines.find((line) => visible(line).includes("Issue:"))!;
    const fix = lines.find((line) => visible(line).includes("Fix:"))!;

    expect(header).toContain("\u001b[38;2;239;101;89mESLint  no-unused-vars");
    expect(header).toContain("\u001b[38;2;146;152;165msrc/app.ts:42");
    expect(source).toContain("\u001b[38;2;146;152;165m");
    expect(issue).toContain("\u001b[38;2;231;233;239m");
    expect(issue).toMatch(
      /\u001b\[1m(?:\u001b\[38;2;231;233;239m)?Issue: \u001b\[22m/u,
    );
    expect(fix).toContain("\u001b[38;2;231;233;239m");
    expect(fix).toMatch(
      /\u001b\[1m(?:\u001b\[38;2;231;233;239m)?Fix: \u001b\[22m/u,
    );
  });

  it.each([20, 40, 60])(
    "bounds every finding line to a %i-column terminal without truncating content",
    async (width) => {
      const React = await import("react");
      const { render } = await import("ink-testing-library");
      const { FindingsList } = await import("../../src/ui/findings-list.js");
      const frame = render(
        React.createElement(FindingsList, {
          findings: [
            createFinding({
              check: "lint",
              rule: "no-unused-vars",
              message: "Variable is assigned but never used.",
              location: { file: "src/app.ts", startLine: 42 },
              remediation: "Remove it or use the value.",
              sourceExcerpt: {
                line: 42,
                text: "const unused = calculateValue(finalArgument)",
                redacted: false,
                truncated: false,
              },
            }),
          ],
          width,
          color: false,
        }),
      ).lastFrame()!;

      expect(maxVisibleWidth(frame)).toBeLessThanOrEqual(width);
      expect(visible(frame).replaceAll(/\s/gu, "")).toContain(
        "constunused=calculateValue(finalArgument)",
      );
      expect(frame).not.toContain("…");
    },
  );

  it.each([20, 40])(
    "stacks the location below the finding header at %i columns",
    async (width) => {
      const React = await import("react");
      const { render } = await import("ink-testing-library");
      const { FindingsList } = await import("../../src/ui/findings-list.js");
      const frame = render(
        React.createElement(FindingsList, {
          findings: [wideFinding()],
          width,
          color: false,
        }),
      ).lastFrame()!;
      const lines = frame.split("\n").map(visible);
      const header = lines.findIndex((line) => line.includes("no-unused-vars"));
      const location = lines.findIndex((line) =>
        line.includes("src/app.ts:42"),
      );

      expect(location).toBeGreaterThan(header);
      expect(lines[header]).not.toContain("src/app.ts:42");
    },
  );

  it("aligns narrow source, Issue, and Fix continuations under their content", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { FindingsList } = await import("../../src/ui/findings-list.js");
    const frame = render(
      React.createElement(FindingsList, {
        findings: [
          createFinding({
            check: "lint",
            rule: "fixture",
            message: "Variable is assigned but never used.",
            location: { file: "src/app.ts", startLine: 42 },
            remediation: "Remove it or use the value.",
            sourceExcerpt: {
              line: 42,
              text: "const unused = calculateValue()",
              redacted: false,
              truncated: false,
            },
          }),
        ],
        width: 20,
        color: false,
      }),
    ).lastFrame()!;
    const lines = frame.split("\n").map(visible);
    const source = lines.findIndex((line) => line.includes("42 │"));
    const issue = lines.findIndex((line) => line.includes("Issue:"));
    const fix = lines.findIndex((line) => line.includes("Fix:"));

    expect(lines[source + 1]).toMatch(/^ {9}\S/u);
    expect(lines[issue + 1]).toMatch(/^ {10}\S/u);
    expect(lines[fix + 1]).toMatch(/^ {9}\S/u);
  });

  it("redacts secret source even if an upstream excerpt contains raw text", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { FindingsList } = await import("../../src/ui/findings-list.js");
    const frame = render(
      React.createElement(FindingsList, {
        findings: [
          createFinding({
            check: "secrets",
            rule: "generic-api-key",
            location: { file: "src/app.ts", startLine: 42 },
            sourceExcerpt: {
              line: 42,
              text: "sk-live-seeded-secret",
              redacted: false,
              truncated: false,
            },
          }),
        ],
        width: 60,
        color: false,
      }),
    ).lastFrame()!;

    expect(frame).toContain("42 │ [redacted]");
    expect(frame).not.toContain("sk-live-seeded-secret");
  });

  it("renders a producer-truncated source excerpt with one terminal ellipsis", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { FindingsList } = await import("../../src/ui/findings-list.js");
    const frame = render(
      React.createElement(FindingsList, {
        findings: [
          createFinding({
            location: { file: "src/app.ts", startLine: 42 },
            sourceExcerpt: {
              line: 42,
              text: "const bounded = value…",
              redacted: false,
              truncated: true,
            },
          }),
        ],
        width: 60,
        color: false,
      }),
    ).lastFrame()!;
    const sourceLine = frame
      .split("\n")
      .map(visible)
      .find((line) => line.includes("const bounded"))!;

    expect(sourceLine).toContain("42 │ const bounded = value…");
    expect(sourceLine.match(/…/gu)).toHaveLength(1);
    expect(sourceLine).not.toContain("……");
  });

  it("omits Fix when a finding has no remediation", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { FindingsList } = await import("../../src/ui/findings-list.js");
    const { remediation: _remediation, ...finding } = wideFinding();
    const frame = render(
      React.createElement(FindingsList, {
        findings: [finding],
        width: 60,
        color: false,
      }),
    ).lastFrame()!;

    expect(frame).toContain("Issue:");
    expect(frame).not.toContain("Fix:");
  });
});
