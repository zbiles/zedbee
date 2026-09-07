import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  INK_MINIMUM_DISPLAY_MS,
  inkMaxFps,
  openInkSession,
} from "../../src/ui/render-ink.js";
import { executeScanCommand } from "../../src/commands/scan.js";
import type { RunScanOptions } from "../../src/scan/run-scan.js";
import type { ScanReport } from "../../src/scan/report.js";
import type { prepareTerminalPresentation } from "../../src/reporting/presentation.js";
import type { TemporaryReportStore } from "../../src/reporting/temporary-reports.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

// Exercise the real command/renderer boundary, with analysis and storage fixtures.
async function runInkScan(
  scanOptions: RunScanOptions,
  viewOptions: Parameters<typeof openInkSession>[0],
  dependencies: {
    runScan?: (options: RunScanOptions) => Promise<ScanReport>;
    preparePresentation?: typeof prepareTerminalPresentation;
    store?: TemporaryReportStore;
    interactive?: boolean;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<ScanReport> {
  let report: ScanReport | undefined;
  const exit = await executeScanCommand(
    {
      cwd: scanOptions.repositoryRoot,
      format: viewOptions.requestedFormat,
      color: viewOptions.color,
      animations: viewOptions.animations,
    },
    {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      width: viewOptions.width,
      env: {},
      writeStdout: (value) => {
        process.stdout.write(value);
      },
      writeStderr: (value) => {
        process.stderr.write(value);
      },
    },
    {
      resolveRepositoryRoot: async () => scanOptions.repositoryRoot,
      scan: async (options) => {
        report = await (dependencies.runScan?.(options) ?? createReport());
        return report;
      },
      preparePresentation: async (result, options) =>
        dependencies.preparePresentation?.(result, {
          ...options,
          store: dependencies.store ?? {
            maintain: async () => ({ warnings: [] }),
          },
        }) ?? {
          automatic: false,
          reportStatus: "not-requested",
          findings: result.summary.findings,
          totalFindingCount: result.summary.findings.length,
          abbreviated: false,
          warnings: [],
        },
      openInk: (options, onError) =>
        openInkSession(options, onError, dependencies),
    },
  );
  expect(exit).toBe(report?.exitCode);
  return report!;
}

describe("runInkScan", () => {
  it.each(["auto", "ink"] as const)(
    "does not deliver the final %s report when cancelled during minimum display",
    async (format) => {
      const controller = new AbortController();
      const output: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
        ...args: unknown[]
      ) => {
        output.push(String(args[0] ?? ""));
        const callback = args.find((value) => typeof value === "function");
        if (typeof callback === "function")
          queueMicrotask(() => (callback as (error: null) => void)(null));
        return true;
      }) as typeof process.stdout.write);
      const finding = createFinding({ message: "fixture final finding" });
      const report = createReport({
        outcome: "blocked",
        exitCode: 1,
        summary: {
          passed: 0,
          failed: 1,
          warnings: 0,
          incomplete: 0,
          findings: [finding],
        },
      });
      let scans = 0;
      let preparations = 0;
      let waits = 0;
      let closes = 0;
      try {
        const exit = await executeScanCommand(
          {
            cwd: "/repo",
            format,
            color: false,
            animations: true,
            signal: controller.signal,
            diagnostics: true,
          },
          {
            stdinIsTTY: true,
            stdoutIsTTY: true,
            width: 120,
            env: {},
            writeStdout: (value) => {
              output.push(value);
            },
            writeStderr: (value) => {
              output.push(value);
            },
          },
          {
            resolveRepositoryRoot: async () => "/repo",
            scan: async () => {
              scans++;
              return report;
            },
            preparePresentation: async () => {
              preparations++;
              return {
                automatic: format === "auto",
                reportStatus: "not-requested",
                findings: [finding],
                totalFindingCount: 1,
                abbreviated: false,
                warnings: [],
              };
            },
            openInk: async (options, onError) => {
              const session = await openInkSession(options, onError, {
                interactive: false,
                wait: async (milliseconds) => {
                  waits++;
                  expect(milliseconds).toBeGreaterThan(0);
                  controller.abort(new Error("fixture-secret-marker"));
                },
              });
              return {
                ...session,
                async close() {
                  closes++;
                  await session.close();
                },
              };
            },
          },
        );
        expect(exit).toBe(2);
        expect(scans).toBe(1);
        expect(preparations).toBe(1);
        expect(waits).toBe(1);
        expect(closes).toBe(1);
        expect(output.join("")).not.toContain("fixture final finding");
        expect(output.join("")).not.toContain("SCAN RESULT");
        expect(output.join("")).not.toContain("fixture-secret-marker");
        expect(
          JSON.parse(output.join("").split("ZEDBEE DIAGNOSTICS\n")[1]!),
        ).toMatchObject({ cancelled: true, renderingFailed: false });
      } finally {
        stdout.mockRestore();
      }
    },
  );
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
        { repositoryRoot: "/repo" },
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
        { repositoryRoot: "/repo" },
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
        { repositoryRoot: "/repo" },
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
