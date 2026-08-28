import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render as renderInk } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { FixPlan } from "../../src/fixes/types.js";
import {
  FixApp,
  fixRenderOptions,
  isFixCancellationInput,
} from "../../src/ui/fix-app.js";

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

function setup(
  value = plan,
  columns = 100,
  rows = 80,
  color = false,
  reportPath: string | null = "/tmp/zedbee/fix-plan.json",
) {
  const onDecision = vi.fn();
  const view = render(
    <FixApp
      plan={value}
      width={columns}
      terminalSize={{ columns, rows }}
      color={color}
      animations={false}
      {...(reportPath === null ? {} : { reportPath })}
      onDecision={onDecision}
    />,
  );
  return { onDecision, view };
}

function lines(frame: string): readonly string[] {
  return stripVTControlCharacters(frame).split("\n");
}

describe("FixApp", () => {
  it("recognizes terminal control-C as cancellation when alternate-screen input is delegated", () => {
    expect(isFixCancellationInput("\u0003", {})).toBe(true);
    expect(isFixCancellationInput("c", { ctrl: true })).toBe(true);
    expect(isFixCancellationInput("c", {})).toBe(false);
  });

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
    expect(stripVTControlCharacters(frame)).toContain(
      "1 file has unstaged work",
    );
    expect(stripVTControlCharacters(frame)).toContain("src/app.ts");
    expect(stripVTControlCharacters(frame)).toContain("2 fixes · 1 blocking");
    expect(stripVTControlCharacters(frame)).toContain(
      "src/components/Badge.tsx",
    );
    expect(stripVTControlCharacters(frame)).toContain(
      "APPLY — format current working file (includes unstaged changes)",
    );
    expect(stripVTControlCharacters(frame)).toContain(
      "Complete plan: /tmp/zedbee/fix-plan.json",
    );
    expect(stripVTControlCharacters(frame)).toContain("➜ APPLY FIXES");
    expect(stripVTControlCharacters(frame)).toContain("CANCEL");
    expect(stripVTControlCharacters(frame)).not.toContain("lint-1");
  });

  it.each([
    ["Space", " "],
    ["Enter", "\r"],
  ])(
    "applies with %s from the focused Apply control",
    async (_label, input) => {
      const { onDecision, view } = setup();

      view.stdin.write(input);
      await vi.waitFor(() => expect(onDecision).toHaveBeenCalledWith(true));
    },
  );

  it.each([
    ["Space", " "],
    ["Enter", "\r"],
  ])(
    "cancels with %s from the focused Cancel control",
    async (_label, input) => {
      const { onDecision, view } = setup();

      view.stdin.write("\t");
      await vi.waitFor(() => expect(visibleFrame(view)).toContain("➜ CANCEL"));
      view.stdin.write(input);

      await vi.waitFor(() => expect(onDecision).toHaveBeenCalledWith(false));
    },
  );

  it("cleans up mouse reporting when Apply exits", async () => {
    const apply = setup();
    await vi.waitFor(() =>
      expect(apply.view.frames.join("")).toContain(
        "\u001b[?1000h\u001b[?1006h",
      ),
    );

    apply.view.stdin.write("\r");

    await vi.waitFor(() => expect(apply.onDecision).toHaveBeenCalledWith(true));
    expect(apply.view.frames.join("")).toContain("\u001b[?1006l\u001b[?1000l");
  });

  it("cleans up mouse reporting when the focused Cancel control exits", async () => {
    const cancel = setup();
    await vi.waitFor(() =>
      expect(cancel.view.frames.join("")).toContain(
        "\u001b[?1000h\u001b[?1006h",
      ),
    );
    cancel.view.stdin.write("\t");
    await vi.waitFor(() =>
      expect(visibleFrame(cancel.view)).toContain("➜ CANCEL"),
    );
    cancel.view.stdin.write("\r");

    await vi.waitFor(() =>
      expect(cancel.onDecision).toHaveBeenCalledWith(false),
    );
    expect(cancel.view.frames.join("")).toContain("\u001b[?1006l\u001b[?1000l");
  });

  it("explains that exact fixes preserve unrelated unstaged work", () => {
    const exactPlan: FixPlan = {
      ...plan,
      files: [{ path: "src/app.ts", fixes: 2, hasUnstagedChanges: true }],
      items: [plan.items[0]!],
    };
    const { view } = setup(exactPlan);

    expect(visibleFrame(view)).toContain(
      "APPLY — exact fixes preserve unrelated unstaged changes",
    );
    expect(visibleFrame(view)).not.toContain("SKIP — unstaged changes");
  });

  it("keeps all file actions visible when a truncated plan has no complete report", () => {
    const reportlessPlan: FixPlan = {
      ...plan,
      summary: { fixes: 13, files: 13, blocking: 0, warnings: 0, skipped: 0 },
      files: Array.from({ length: 13 }, (_, index) => ({
        path: `src/${index}.ts`,
        fixes: 1,
        hasUnstagedChanges: false,
      })),
      items: Array.from({ length: 13 }, (_, index) => ({
        checkId: "lint" as const,
        file: `src/${index}.ts`,
        findingIds: [`lint-${index}`],
        scope: "finding" as const,
        blocking: 0,
        warnings: 0,
      })),
    };
    const { view } = setup(reportlessPlan, 100, 200, false, null);

    expect(visibleFrame(view)).toContain("src/12.ts");
    expect(visibleFrame(view)).not.toContain("Showing 12 of 13 planned files");
    expect(visibleFrame(view)).not.toContain("Complete plan:");
    expect(visibleFrame(view)).not.toContain("lint-12");
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

  it("homes the alternate screen exactly once", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const options = fixRenderOptions();

    options.onRender?.();
    options.onRender?.();

    expect(options).toMatchObject({
      alternateScreen: true,
      exitOnCtrlC: false,
    });
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("\u001b[H");
    write.mockRestore();
  });

  it("disables mouse reporting before the renderer leaves the alternate screen", async () => {
    const output: string[] = [];
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
    const stderr = new PassThrough() as PassThrough & NodeJS.WriteStream;
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
    Object.defineProperties(stdout, {
      columns: { value: 80 },
      isTTY: { value: true },
      rows: { value: 40 },
    });
    Object.defineProperties(stdin, {
      isTTY: { value: true },
      ref: { value: vi.fn() },
      setRawMode: { value: vi.fn() },
      unref: { value: vi.fn() },
    });
    stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    const cursorWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const app = renderInk(
      <FixApp
        plan={plan}
        width={80}
        terminalSize={{ columns: 80, rows: 40 }}
        color={false}
        animations={false}
        onDecision={() => undefined}
      />,
      {
        ...fixRenderOptions(),
        stdout,
        stderr,
        stdin,
        debug: true,
        interactive: true,
      },
    );

    try {
      await vi.waitFor(() =>
        expect(output.join("")).toContain("\u001b[?1000h\u001b[?1006h"),
      );
      app.unmount();
      await app.waitUntilExit();

      const writes = output.join("");
      expect(writes.indexOf("\u001b[?1006l\u001b[?1000l")).toBeLessThan(
        writes.indexOf("\u001b[?1049l"),
      );
    } finally {
      cursorWrite.mockRestore();
      stdout.destroy();
      stderr.destroy();
      stdin.destroy();
    }
  });

  it("defensively disables mouse reporting when prompt rendering rejects", async () => {
    const failure = new Error("wait failed after mouse activation");
    const waitUntilExit = vi.fn(async () => Promise.reject(failure));
    const renderMock = vi.fn((_node: unknown, _options?: unknown) => {
      process.stdout.write("\u001b[?1000h\u001b[?1006h");
      return { waitUntilExit };
    });
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.resetModules();
    vi.doMock("ink", async () => {
      const actual = await vi.importActual<typeof import("ink")>("ink");
      return { ...actual, render: renderMock };
    });

    try {
      const { runFixPrompt } = await import("../../src/ui/fix-app.js");
      await expect(
        runFixPrompt(plan, { width: 80, color: false, animations: false }),
      ).rejects.toThrow("wait failed after mouse activation");

      expect(waitUntilExit).toHaveBeenCalledOnce();
      expect(renderMock.mock.calls[0]?.[1]).toMatchObject({
        alternateScreen: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      expect(write.mock.calls.map(([value]) => String(value))).toEqual([
        "\u001b[?1000h\u001b[?1006h",
        "\u001b[?1006l\u001b[?1000l",
      ]);
    } finally {
      write.mockRestore();
      vi.doUnmock("ink");
      vi.resetModules();
    }
  });

  it("unmounts an active prompt and rejects when its abort signal fires", async () => {
    const controller = new AbortController();
    let resolveExit: (() => void) | undefined;
    const waitUntilExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExit = resolve;
        }),
    );
    const unmount = vi.fn(() => {
      process.stdout.write("\u001b[?1006l\u001b[?1000l");
      process.stdout.write("\u001b[?1049l");
      resolveExit?.();
    });
    const renderMock = vi.fn(() => {
      process.stdout.write("\u001b[?1000h\u001b[?1006h");
      return { unmount, waitUntilExit };
    });
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.resetModules();
    vi.doMock("ink", async () => {
      const actual = await vi.importActual<typeof import("ink")>("ink");
      return { ...actual, render: renderMock };
    });

    try {
      const { runFixPrompt } = await import("../../src/ui/fix-app.js");
      const pending = runFixPrompt(plan, {
        width: 80,
        color: false,
        animations: false,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(renderMock).toHaveBeenCalledOnce());
      controller.abort();

      await expect(pending).rejects.toThrow();
      expect(unmount).toHaveBeenCalledOnce();
      const writes = write.mock.calls.map(([value]) => String(value)).join("");
      expect(writes.indexOf("\u001b[?1006l\u001b[?1000l")).toBeLessThan(
        writes.indexOf("\u001b[?1049l"),
      );
    } finally {
      write.mockRestore();
      vi.doUnmock("ink");
      vi.resetModules();
    }
  });

  it("rejects an already-aborted prompt without rendering", async () => {
    const controller = new AbortController();
    controller.abort();
    const renderMock = vi.fn();
    vi.resetModules();
    vi.doMock("ink", async () => {
      const actual = await vi.importActual<typeof import("ink")>("ink");
      return { ...actual, render: renderMock };
    });

    try {
      const { runFixPrompt } = await import("../../src/ui/fix-app.js");
      await expect(
        runFixPrompt(plan, {
          width: 80,
          color: false,
          animations: false,
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(renderMock).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("ink");
      vi.resetModules();
    }
  });
});
