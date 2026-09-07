import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  INK_MINIMUM_DISPLAY_MS,
  inkMaxFps,
  runInkScan,
} from "../../src/ui/render-ink.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

describe("runInkScan", () => {
  it("retains the 400 ms minimum live-dashboard duration", () => {
    expect(INK_MINIMUM_DISPLAY_MS).toBe(400);
  });

  it("keeps the animated live interface visible before the compact report", async () => {
    const startedAt = performance.now();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      const callback = args.find((value) => typeof value === "function");
      if (typeof callback === "function")
        queueMicrotask(callback as () => void);
      return true;
    }) as typeof process.stdout.write);

    try {
      const report = await runInkScan(
        { repositoryRoot: "/repo" },
        {
          requestedFormat: "ink",
          color: false,
          animations: true,
          width: 120,
        },
        { runScan: vi.fn(async () => createReport({ checks: [] })) },
      );

      expect(report.checks).toHaveLength(0);
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(390);
    } finally {
      stdout.mockRestore();
    }
  });

  it("keeps event-driven rerenders responsive when animation is disabled", () => {
    expect(inkMaxFps(false)).toBeGreaterThan(1);
    expect(inkMaxFps(false)).toBe(inkMaxFps(true));
  });

  it("does not impose the animated minimum display time without animation", async () => {
    const repository = await createGitRepository("zedbee-ink-no-animation-");
    await repository.write(
      "package.json",
      '{"name":"ink-no-animation-fixture","private":true}\n',
    );
    await repository.commitAll("fixture setup");
    const wait = vi.fn(async () => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      const callback = args.find((value) => typeof value === "function");
      if (typeof callback === "function")
        queueMicrotask(callback as () => void);
      return true;
    }) as typeof process.stdout.write);

    try {
      await runInkScan(
        { repositoryRoot: repository.root },
        {
          requestedFormat: "ink",
          color: false,
          animations: false,
          width: 120,
        },
        { wait },
      );

      expect(wait).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it("keeps explicit Ink final output and requested-format identity truthful", async () => {
    const repository = await createGitRepository("zedbee-ink-presentation-");
    await repository.write(
      "package.json",
      '{"name":"ink-presentation-fixture","private":true}\n',
    );
    await repository.commitAll("fixture setup");
    const output: string[] = [];
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "rows", {
      configurable: true,
      value: 100,
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      output.push(String(args[0] ?? ""));
      const callback = args.find((value) => typeof value === "function");
      if (typeof callback === "function")
        queueMicrotask(callback as () => void);
      return true;
    }) as typeof process.stdout.write);
    const store = {
      maintain: vi.fn(async () => ({ warnings: [] })),
    };
    const preparePresentation = vi.fn(async (_report, options) => {
      expect(options).toMatchObject({
        requestedFormat: "ink",
        selectedFormat: "ink",
        store,
      });
      return {
        automatic: false,
        reportStatus: "available" as const,
        findings: [createFinding({ rule: "shown-rule" })],
        totalFindingCount: 2,
        abbreviated: true,
        reportPath: "/tmp/zedbee-reports/hash/complete.json",
        maximumAge: "24h",
        warnings: [
          {
            code: "TEMP_REPORT_CLEANUP_FAILED" as const,
            message: "An expired report remains.",
          },
        ],
      };
    });

    try {
      await runInkScan(
        { repositoryRoot: repository.root },
        {
          requestedFormat: "ink",
          color: false,
          animations: false,
          width: 120,
        },
        { preparePresentation, store, interactive: true },
      );
    } finally {
      stdout.mockRestore();
      if (isTTY === undefined)
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, "isTTY", isTTY);
      if (rows === undefined) delete (process.stdout as { rows?: number }).rows;
      else Object.defineProperty(process.stdout, "rows", rows);
    }

    const rendered = output.join("");
    expect(preparePresentation).toHaveBeenCalledOnce();
    expect(rendered).toContain("shown-rule");
    expect(rendered).toContain("REPORT MAINTENANCE WARNING");
    expect(rendered).toContain("NEXT STEPS");
    expect(rendered).not.toContain("SCAN RESULT");
    expect(rendered).not.toContain("\u001b[?1049h");
  });

  it("restores terminal history before appending the automatic result", async () => {
    const repository = await createGitRepository("zedbee-auto-ink-result-");
    await repository.write(
      "package.json",
      '{"name":"auto-ink-result-fixture","private":true}\n',
    );
    await repository.commitAll("fixture setup");
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
    const store = {
      maintain: vi.fn(async () => ({ warnings: [] })),
    };
    const preparePresentation = vi.fn(async (_report, options) => {
      expect(options).toMatchObject({
        requestedFormat: "auto",
        selectedFormat: "ink",
        store,
      });
      return {
        automatic: true,
        reportStatus: "available" as const,
        findings: [],
        totalFindingCount: 0,
        abbreviated: false,
        reportPath: "/tmp/zedbee-reports/hash/complete.json",
        maximumAge: "24h",
        warnings: [],
      };
    });

    try {
      await runInkScan(
        { repositoryRoot: repository.root },
        {
          requestedFormat: "auto",
          color: false,
          animations: false,
          width: 120,
        },
        { preparePresentation, store, interactive: true },
      );
    } finally {
      stdout.mockRestore();
      if (isTTY === undefined)
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, "isTTY", isTTY);
      if (rows === undefined) delete (process.stdout as { rows?: number }).rows;
      else Object.defineProperty(process.stdout, "rows", rows);
    }

    const resultWrites = output.filter((chunk) =>
      chunk.includes("SCAN RESULT"),
    );
    expect(resultWrites).toHaveLength(1);
    expect(resultWrites[0]).toContain("▀▀▀▀█ █▀▀▀▀");
    expect(resultWrites[0]).toContain("COMPLETE REPORT");
    const rendered = output.join("");
    const temporaryScreenStart = rendered.indexOf("\u001b[?1049h");
    const temporaryScreenEnd = rendered.indexOf("\u001b[?1049l");
    const cursorHome = rendered.indexOf("\u001b[H", temporaryScreenStart);
    const liveFrameStart = rendered.indexOf("CHECKS", temporaryScreenStart);
    const resultStart = rendered.indexOf("SCAN RESULT");
    expect(temporaryScreenStart).toBeGreaterThanOrEqual(0);
    expect(temporaryScreenEnd).toBeGreaterThan(temporaryScreenStart);
    expect(cursorHome).toBeGreaterThan(temporaryScreenStart);
    expect(liveFrameStart).toBeGreaterThan(cursorHome);
    expect(cursorHome).toBeLessThan(temporaryScreenEnd);
    expect(resultStart).toBeGreaterThan(temporaryScreenEnd);
    expect(rendered.slice(temporaryScreenEnd)).not.toContain("ACTIVITY");
    expect(rendered.slice(0, temporaryScreenStart)).not.toContain(
      "\u001b[2J\u001b[3J\u001b[H",
    );
    expect(rendered.slice(temporaryScreenEnd)).not.toContain(
      "\u001b[2J\u001b[3J\u001b[H",
    );
  });
});
