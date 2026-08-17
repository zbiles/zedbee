import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckResult } from "../../src/core/types.js";

const originalForceColor = process.env.FORCE_COLOR;
const cleanupPath = "/private/tmp/zedbee-snapshot-validated-123";
const remediation = "Remove the temporary directory manually, then scan again.";

const checks: readonly CheckResult[] = [
  {
    checkId: "formatting",
    status: "completed",
    durationMs: 1,
    findings: [],
  },
  {
    checkId: "zedbee",
    status: "incomplete",
    durationMs: 4,
    findings: [],
    error: {
      code: "SNAPSHOT_CLEANUP_FAILED",
      message: "Zedbee could not remove its temporary snapshot.",
      path: "src/app.ts",
      temporaryPath: cleanupPath,
      remediation,
    },
  },
];

function visible(value: string): string {
  return value.replaceAll(/\u001b\[[0-9;]*m/gu, "");
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

describe("IncompleteList", () => {
  it("renders only incomplete checks in deterministic report order", async () => {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { IncompleteList } = await import("../../src/ui/incomplete-list.js");
    const second: CheckResult = {
      checkId: "types",
      status: "incomplete",
      durationMs: 2,
      findings: [],
      error: {
        code: "TYPES_UNAVAILABLE",
        message: "TypeScript could not start.",
        remediation: "Install the managed analyzer, then scan again.",
      },
    };
    const frame = render(
      React.createElement(IncompleteList, {
        checks: [...checks, second],
        width: 96,
        color: false,
      }),
    ).lastFrame()!;

    expect(frame).toContain("⚠ INCOMPLETE CHECKS");
    expect(frame).not.toContain("Formatting");
    expect(frame.indexOf("SNAPSHOT CLEANUP FAILED")).toBeLessThan(
      frame.indexOf("TYPES UNAVAILABLE"),
    );
    expect(frame).toContain("Zedbee could not remove its temporary snapshot.");
    expect(frame).toContain("Path: src/app.ts");
    expect(frame).toContain(`Cleanup: ${cleanupPath}`);
    expect(frame).toContain(`Fix: ${remediation}`);
  });

  it.each([20, 40, 60])(
    "wraps incomplete details within %i columns without dropping the validated path",
    async (width) => {
      const React = await import("react");
      const { render } = await import("ink-testing-library");
      const { IncompleteList } =
        await import("../../src/ui/incomplete-list.js");
      const frame = render(
        React.createElement(IncompleteList, {
          checks,
          width,
          color: false,
        }),
      ).lastFrame()!;

      expect(
        Math.max(...frame.split("\n").map((line) => [...visible(line)].length)),
      ).toBeLessThanOrEqual(width);
      expect(visible(frame).replaceAll(/\s/gu, "")).toContain(cleanupPath);
      expect(visible(frame).replaceAll(/\s+/gu, " ")).toContain(
        "Remove the temporary directory manually, then scan again.",
      );
    },
  );

  it("uses warning for the section and primary/secondary tones for safe copy and paths", async () => {
    process.env.FORCE_COLOR = "3";
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { IncompleteList } = await import("../../src/ui/incomplete-list.js");
    const frame = render(
      React.createElement(IncompleteList, {
        checks,
        width: 96,
        color: true,
      }),
    ).lastFrame()!;
    const lines = frame.split("\n");
    const heading = lines.find((line) =>
      visible(line).includes("INCOMPLETE CHECKS"),
    )!;
    const message = lines.find((line) =>
      visible(line).includes("could not remove"),
    )!;
    const path = lines.find((line) =>
      visible(line).includes("Path: src/app.ts"),
    )!;
    const cleanup = lines.find((line) => visible(line).includes(cleanupPath))!;
    const fix = lines.find((line) => visible(line).includes("Fix:"))!;

    expect(heading).toContain("\u001b[38;2;232;184;76m");
    expect(message).toContain("\u001b[38;2;231;233;239m");
    expect(path).toContain("\u001b[38;2;146;152;165m");
    expect(cleanup).toContain("\u001b[38;2;146;152;165m");
    expect(fix).toContain("\u001b[38;2;231;233;239m");
  });
});
