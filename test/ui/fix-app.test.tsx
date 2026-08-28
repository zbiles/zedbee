import { stripVTControlCharacters } from "node:util";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { FixPlan } from "../../src/fixes/types.js";
import { FixApp } from "../../src/ui/fix-app.js";

const plan: FixPlan = {
  schemaVersion: 1,
  target: "index",
  selectedChecks: ["formatting", "lint", "reactCorrectness"],
  exitCode: 0,
  summary: { fixes: 4, files: 3, blocking: 1, warnings: 2, skipped: 1 },
  files: [
    { path: "src/app.ts", fixes: 2, hasUnstagedChanges: false },
    { path: "src/components/Badge.tsx", fixes: 1, hasUnstagedChanges: true },
    { path: "src/hooks/useBee.ts", fixes: 1, hasUnstagedChanges: false },
  ],
  items: [
    {
      checkId: "lint",
      file: "src/app.ts",
      findingIds: ["lint-1", "lint-2"],
      scope: "finding",
      blocking: 1,
      warnings: 0,
    },
    {
      checkId: "formatting",
      file: "src/components/Badge.tsx",
      findingIds: ["format-1"],
      scope: "working-file",
      blocking: 0,
      warnings: 1,
    },
    {
      checkId: "reactCorrectness",
      file: "src/hooks/useBee.ts",
      findingIds: ["react-1"],
      scope: "finding",
      blocking: 0,
      warnings: 1,
    },
  ],
};

function visibleFrame(view: { readonly frames: readonly string[] }): string {
  return view.frames.findLast(
    (frame) => stripVTControlCharacters(frame).trim().length > 0,
  )!;
}

function setup(value = plan, columns = 100, rows = 80, color = false) {
  const onDecision = vi.fn();
  const view = render(
    <FixApp
      plan={value}
      width={columns}
      terminalSize={{ columns, rows }}
      color={color}
      animations={false}
      reportPath="/tmp/zedbee/fix-plan.json"
      onDecision={onDecision}
    />,
  );
  return { onDecision, view };
}

function lines(frame: string): readonly string[] {
  return stripVTControlCharacters(frame).split("\n");
}

describe("FixApp", () => {
  it("renders the branded framed plan with bounded summaries and safe file actions", () => {
    const { view } = setup(plan, 140, 80, true);
    const frame = visibleFrame(view);

    expect(stripVTControlCharacters(frame)).toContain("██████████");
    expect(stripVTControlCharacters(frame)).toContain("FIX PLAN");
    expect(stripVTControlCharacters(frame)).toContain(
      "Checks: formatting, lint",
    );
    expect(stripVTControlCharacters(frame)).toContain("4 fixes across 3 files");
    expect(stripVTControlCharacters(frame)).toContain("1 blocking");
    expect(stripVTControlCharacters(frame)).toContain("2 warnings");
    expect(stripVTControlCharacters(frame)).toContain("1 skipped");
    expect(stripVTControlCharacters(frame)).toContain("1 unstaged file");
    expect(stripVTControlCharacters(frame)).toContain("src/app.ts");
    expect(stripVTControlCharacters(frame)).toContain("2 fixes · 1 blocking");
    expect(stripVTControlCharacters(frame)).toContain(
      "src/components/Badge.tsx",
    );
    expect(stripVTControlCharacters(frame)).toContain(
      "SKIP — unstaged changes",
    );
    expect(stripVTControlCharacters(frame)).toContain(
      "Complete plan: /tmp/zedbee/fix-plan.json",
    );
    expect(stripVTControlCharacters(frame)).toContain("➜ APPLY FIXES");
    expect(stripVTControlCharacters(frame)).toContain("CANCEL");
    expect(stripVTControlCharacters(frame)).not.toContain("lint-1");
  });

  it("moves focus with Tab and applies only from the focused control", async () => {
    const { onDecision, view } = setup();

    view.stdin.write("\t");
    await vi.waitFor(() => expect(visibleFrame(view)).toContain("➜ CANCEL"));
    view.stdin.write("\u001b[C");
    await vi.waitFor(() =>
      expect(visibleFrame(view)).toContain("➜ APPLY FIXES"),
    );
    view.stdin.write(" ");

    await vi.waitFor(() => expect(onDecision).toHaveBeenCalledWith(true));
  });

  it("cancels with Escape while releasing terminal mouse reporting", async () => {
    const escape = setup();
    await vi.waitFor(() =>
      expect(escape.view.frames.join("")).toContain(
        "\u001b[?1000h\u001b[?1006h",
      ),
    );
    escape.view.stdin.write("\u001b");
    await vi.waitFor(() =>
      expect(escape.onDecision).toHaveBeenCalledWith(false),
    );
    expect(escape.view.frames.join("")).toContain("\u001b[?1006l\u001b[?1000l");
  });

  it("scrolls the whole frame by keyboard and SGR wheel only when it overflows", async () => {
    const tallPlan: FixPlan = {
      ...plan,
      files: Array.from({ length: 12 }, (_, index) => ({
        path: `src/generated-${index}.ts`,
        fixes: 1,
        hasUnstagedChanges: false,
      })),
    };
    const { view } = setup(tallPlan, 80, 20);
    await vi.waitFor(() =>
      expect(visibleFrame(view)).toContain("↓ MORE BELOW"),
    );
    const before = visibleFrame(view);

    view.stdin.write("\u001b[B");
    await vi.waitFor(() =>
      expect(visibleFrame(view)).toContain("↑ MORE ABOVE"),
    );
    expect(visibleFrame(view)).not.toBe(before);

    view.stdin.write("\u001b[<65;20;8M");
    await vi.waitFor(() => expect(visibleFrame(view)).not.toBe(before));
    view.stdin.write("\u001b[5~");
    await vi.waitFor(() =>
      expect(visibleFrame(view)).toContain("↑ MORE ABOVE"),
    );
  });

  it("keeps the plan readable within a narrow terminal", () => {
    const { view } = setup(plan, 40, 80);
    const frame = visibleFrame(view);

    expect(frame).toContain("ZEDBEE");
    expect(frame).toContain("FIX PLAN");
    expect(
      Math.max(...lines(frame).map((line) => [...line].length)),
    ).toBeLessThanOrEqual(40);
  });

  it("preserves the focused control when a short terminal is resized", async () => {
    const tallPlan: FixPlan = {
      ...plan,
      files: Array.from({ length: 12 }, (_, index) => ({
        path: `src/generated-${index}.ts`,
        fixes: 1,
        hasUnstagedChanges: false,
      })),
    };
    const onDecision = vi.fn();
    const elementFor = (rows: number) => (
      <FixApp
        plan={tallPlan}
        width={80}
        terminalSize={{ columns: 80, rows }}
        color={false}
        animations={false}
        onDecision={onDecision}
      />
    );
    const view = render(elementFor(20));
    await vi.waitFor(() =>
      expect(visibleFrame(view)).toContain("↓ MORE BELOW"),
    );
    view.stdin.write("\t");
    await vi.waitFor(() => expect(visibleFrame(view)).toContain("➜ CANCEL"));

    view.rerender(elementFor(30));
    await vi.waitFor(() => expect(lines(visibleFrame(view))).toHaveLength(30));
    expect(visibleFrame(view)).toContain("➜ CANCEL");
  });
});
