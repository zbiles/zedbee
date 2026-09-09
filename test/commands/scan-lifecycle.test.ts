import { describe, expect, it } from "vitest";
import {
  executeScanCommand,
  type ScanCommandDependencies,
} from "../../src/commands/scan.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

describe("controller-owned scan rendering", () => {
  it.each(["json", "sarif", "text", "ink"] as const)(
    "does not deliver %s when cancellation arrives during report preparation",
    async (format) => {
      const controller = new AbortController();
      const report = createReport();
      let scans = 0;
      let preparations = 0;
      let finishes = 0;
      let closes = 0;
      const stdout: string[] = [];
      const deps: ScanCommandDependencies = {
        resolveRepositoryRoot: async () => "/repo",
        scan: async () => {
          scans++;
          return report;
        },
        preparePresentation: async () => {
          preparations++;
          await Promise.resolve();
          controller.abort(new Error("fixture-secret-marker"));
          return {
            automatic: false,
            reportStatus: "not-requested",
            findings: [],
            totalFindingCount: 0,
            abbreviated: false,
            warnings: [],
          };
        },
        openInk: async () => ({
          update() {},
          async finish() {
            finishes++;
            stdout.push("final report");
          },
          async close() {
            closes++;
          },
        }),
      };
      const exit = await executeScanCommand(
        {
          cwd: "/repo",
          format,
          color: false,
          animations: false,
          signal: controller.signal,
        },
        {
          stdinIsTTY: true,
          stdoutIsTTY: true,
          width: 120,
          env: {},
          writeStdout: (value) => {
            stdout.push(value);
          },
          writeStderr() {},
        },
        deps,
      );
      expect(exit).toBe(2);
      expect(scans).toBe(1);
      expect(preparations).toBe(1);
      expect(finishes).toBe(0);
      expect(closes).toBe(format === "ink" ? 1 : 0);
      expect(stdout).toEqual([]);
    },
  );
  it.each(["open", "update", "finish", "close"] as const)(
    "falls back to complete text after %s fails without repeating analysis or persistence",
    async (failure) => {
      const findings = Array.from({ length: 30 }, (_, i) =>
        createFinding({ id: `f-${i}`, message: `fixture finding ${i}` }),
      );
      const report = createReport({
        outcome: "blocked",
        exitCode: 1,
        checks: [
          {
            checkId: "formatting",
            status: "completed",
            durationMs: 1,
            findings,
          },
        ],
        summary: {
          passed: 0,
          warnings: 0,
          failed: 30,
          incomplete: 0,
          findings,
        },
      });
      let scanCalls = 0;
      let preparations = 0;
      let closes = 0;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const deps: ScanCommandDependencies = {
        resolveRepositoryRoot: async () => "/repo",
        scan: async (options) => {
          scanCalls++;
          options.onEvent?.({
            type: "check-completed",
            checkId: "formatting",
            target: ".",
            timestamp: 1,
            result: report.checks[0]!,
          });
          return report;
        },
        preparePresentation: async () => {
          preparations++;
          return {
            automatic: true,
            reportStatus: "available",
            findings: findings.slice(0, 2),
            totalFindingCount: 30,
            abbreviated: true,
            warnings: [],
          };
        },
        openInk: async () => {
          if (failure === "open") throw new Error("fixture-secret-marker");
          return {
            update() {
              if (failure === "update")
                throw new Error("fixture-secret-marker");
            },
            async finish() {
              if (failure === "finish")
                throw new Error("fixture-secret-marker");
            },
            async close() {
              closes++;
              if (failure === "close") throw new Error("fixture-secret-marker");
            },
          };
        },
      };
      const exitCode = await executeScanCommand(
        { cwd: "/repo", format: "auto", animations: false, color: false },
        {
          stdinIsTTY: true,
          stdoutIsTTY: true,
          width: 120,
          env: {},
          writeStdout: (value) => {
            stdout.push(value);
          },
          writeStderr: (value) => {
            stderr.push(value);
          },
        },
        deps,
      );
      expect(scanCalls).toBe(1);
      expect(preparations).toBe(1);
      expect(closes).toBe(failure === "open" ? 0 : 1);
      expect(exitCode).toBe(report.exitCode);
      for (let i = 0; i < 30; i++)
        expect(stdout.join("")).toContain(`fixture finding ${i}`);
      expect(stderr.join("")).not.toContain("fixture-secret-marker");
    },
  );

  it.each(["cancellation", "stdout"] as const)(
    "does not disguise %s as a successful report delivery",
    async (failure) => {
      const controller = new AbortController();
      let scans = 0;
      let closes = 0;
      let writes = 0;
      const deps: ScanCommandDependencies = {
        resolveRepositoryRoot: async () => "/repo",
        scan: async () => {
          scans++;
          if (failure === "cancellation") {
            controller.abort();
            throw controller.signal.reason;
          }
          return createReport();
        },
        preparePresentation: async () => ({
          automatic: false,
          reportStatus: "not-requested",
          findings: [],
          totalFindingCount: 0,
          abbreviated: false,
          warnings: [],
        }),
        openInk: async () => ({
          update() {},
          async finish() {
            throw new Error("renderer failed");
          },
          async close() {
            closes++;
          },
        }),
      };
      const exit = await executeScanCommand(
        {
          cwd: "/repo",
          format: "ink",
          animations: false,
          color: false,
          signal: controller.signal,
        },
        {
          stdinIsTTY: true,
          stdoutIsTTY: true,
          width: 120,
          env: {},
          writeStdout() {
            writes++;
            throw new Error("stdout failed");
          },
          writeStderr() {},
        },
        deps,
      );
      expect(exit).toBe(2);
      expect(scans).toBe(1);
      expect(closes).toBe(1);
      expect(writes).toBe(failure === "cancellation" ? 0 : 1);
    },
  );
});
