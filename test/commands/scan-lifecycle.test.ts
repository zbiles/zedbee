import { afterEach, describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import {
  executeScanCommand,
  type ScanCommandDependencies,
} from "../../src/commands/scan.js";
import { createFinding, createReport } from "../helpers/scan-report.js";
import { openInkSession } from "../../src/ui/render-ink.js";

const acquire = vi.hoisted(() => vi.fn());
vi.mock("../../src/service/client.js", async (original) => ({
  ...(await original<typeof import("../../src/service/client.js")>()),
  acquireServiceExecutor: acquire,
}));
afterEach(() => acquire.mockReset());

describe("controller-owned scan rendering", () => {
  it("retains one framed closing callout after the automatic live session closes", async () => {
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
    let closes = 0;
    let afterFinish = "";
    let afterClose = "";
    try {
      const report = createReport({
        presentationPolicy: {
          terminalFindingLimit: 25,
          temporaryReportMaxAge: "24h",
          persistSourceExcerpts: false,
          agentGuidance: {
            opening: "Read the complete report.",
            nextStep: "Use the configured next step.",
          },
        },
      });
      const exit = await executeScanCommand(
        { cwd: "/repo", format: "auto", color: false, animations: false },
        {
          stdinIsTTY: true,
          stdoutIsTTY: true,
          width: 120,
          env: {},
          writeStdout: (value) => {
            output.push(value);
          },
          writeStderr() {},
        },
        {
          resolveRepositoryRoot: async () => "/repo",
          scan: async () => report,
          preparePresentation: async () => ({
            automatic: true,
            reportStatus: "available",
            findings: [],
            totalFindingCount: 0,
            abbreviated: false,
            reportPath:
              "/private/tmp/zedbee-reports/synthetic-session/complete.json",
            maximumAge: "24h",
            warnings: [],
          }),
          openInk: async (options, onError) => {
            const session = await openInkSession(options, onError, {
              interactive: false,
            });
            return {
              update: session.update,
              async finish(result, shown) {
                await session.finish(result, shown);
                afterFinish = output.join("");
              },
              async close() {
                closes++;
                await session.close();
                afterClose = output.join("");
              },
            };
          },
        },
      );
      expect(exit).toBe(0);
      expect(closes).toBe(1);
      expect(afterClose).toBe(afterFinish);
      const final = stripVTControlCharacters(afterClose).slice(
        stripVTControlCharacters(afterClose).indexOf("SCAN RESULT"),
      );
      expect(final).toContain("NEXT STEPS");
      expect(final.match(/AGENT NEXT STEP/gu)).toHaveLength(1);
      expect(final.match(/COMPLETE REPORT/gu)).toHaveLength(1);
      expect(final).toContain("Use the configured next step.");
      expect(final).toContain(
        '"/private/tmp/zedbee-reports/synthetic-session/complete.json"',
      );
      const bottom = final
        .split("\n")
        .findIndex((line) => /^ █+ *$/u.test(line));
      expect(bottom).toBeGreaterThan(0);
      expect(
        final
          .split("\n")
          .slice(bottom + 1)
          .join("")
          .trim(),
      ).toBe("");
      expect(
        stripVTControlCharacters(afterClose).match(/COMPLETE REPORT/gu),
      ).toHaveLength(2);
    } finally {
      stdout.mockRestore();
    }
  });

  it.each([false, true])(
    "reports cleanup failure once when a completed report already has cleanup failure: %s",
    async (alreadyFailed) => {
      const completed = createReport();
      const cleanup = {
        checkId: "zedbee",
        status: "incomplete" as const,
        durationMs: 15,
        findings: [],
        error: {
          code: "SNAPSHOT_CLEANUP_FAILED",
          message: "Snapshot cleanup could not finish.",
          remediation: "Remove the retained snapshot after its analyzer stops.",
        },
      };
      const report = alreadyFailed
        ? createReport({
            outcome: "incomplete",
            exitCode: 2,
            checks: [...completed.checks, cleanup],
            summary: { ...completed.summary, incomplete: 1 },
          })
        : completed;
      acquire.mockResolvedValue({
        async openSession() {
          throw new Error("scan fixture does not open analyzer sessions");
        },
        async close() {
          throw new Error("private-executor-secret-marker");
        },
      });
      const stdout: string[] = [];
      const exit = await executeScanCommand(
        { cwd: "/repo", format: "json", color: false, animations: false },
        {
          stdinIsTTY: false,
          stdoutIsTTY: false,
          width: 120,
          env: {},
          writeStdout: (value) => {
            stdout.push(value);
          },
          writeStderr() {},
        },
        {
          resolveRepositoryRoot: async () => "/repo",
          scan: async (options) => {
            options.executor!.prepare!();
            return report;
          },
          openInk: async () => {
            throw new Error("unexpected ink rendering");
          },
          preparePresentation: async () => ({
            automatic: false,
            reportStatus: "not-requested",
            findings: [],
            totalFindingCount: 0,
            abbreviated: false,
            warnings: [],
          }),
        },
      );
      const delivered = JSON.parse(stdout.join(""));
      expect(exit).toBe(2);
      expect(delivered.exitCode).toBe(2);
      expect(delivered.outcome).toBe("incomplete");
      expect(delivered.summary).toMatchObject({ passed: 1, incomplete: 1 });
      expect(delivered.checks).toHaveLength(2);
      expect(delivered.checks[0]).toEqual(completed.checks[0]);
      expect(delivered.checks[1].error.code).toBe("SNAPSHOT_CLEANUP_FAILED");
      if (alreadyFailed) expect(delivered.checks[1]).toEqual(cleanup);
    },
  );

  it.each(["json", "text"] as const)(
    "retains completed findings and the original failure in %s when executor cleanup fails",
    async (format) => {
      const finding = createFinding({
        message: "Retained formatting finding.",
      });
      const diagnostic = {
        checkId: "types",
        operation: "collect",
        category: "abnormal-exit",
        engine: { name: "typescript", version: "6.0.3" },
      } as const;
      const report = createReport({
        outcome: "incomplete",
        exitCode: 2,
        checks: [
          {
            checkId: "formatting",
            status: "completed",
            durationMs: 4,
            findings: [finding],
          },
          {
            checkId: "types",
            status: "incomplete",
            durationMs: 25,
            findings: [],
            error: {
              code: "ANALYZER_FAILED",
              message: "Type analysis could not finish.",
              diagnostic,
            },
          },
        ],
        summary: {
          passed: 0,
          warnings: 0,
          failed: 1,
          incomplete: 1,
          findings: [finding],
        },
      });
      acquire.mockResolvedValue({
        async openSession() {
          throw new Error("scan fixture does not open analyzer sessions");
        },
        async close() {
          throw new Error("private-executor-secret-marker");
        },
      });
      const stdout: string[] = [],
        stderr: string[] = [];
      const exit = await executeScanCommand(
        {
          cwd: "/repo",
          format,
          color: false,
          animations: false,
          diagnostics: true,
        },
        {
          stdinIsTTY: false,
          stdoutIsTTY: false,
          width: 120,
          env: {},
          writeStdout: (value) => {
            stdout.push(value);
          },
          writeStderr: (value) => {
            stderr.push(value);
          },
        },
        {
          resolveRepositoryRoot: async () => "/repo",
          scan: async (options) => {
            options.executor!.prepare!();
            return report;
          },
          openInk: async () => {
            throw new Error("unexpected ink rendering");
          },
          preparePresentation: async (retained) => ({
            automatic: false,
            reportStatus: "not-requested",
            findings: retained.summary.findings,
            totalFindingCount: retained.summary.findings.length,
            abbreviated: false,
            warnings: [],
          }),
        },
      );
      expect(exit).toBe(2);
      expect(stdout.join("")).toContain("Retained formatting finding.");
      expect(stdout.join("")).toContain("Type analysis could not finish.");
      if (format === "json") {
        const delivered = JSON.parse(stdout.join(""));
        expect(delivered.outcome).toBe("incomplete");
        expect(delivered.exitCode).toBe(2);
        expect(delivered.summary).toMatchObject({ failed: 1, incomplete: 2 });
        expect(delivered.checks).toHaveLength(3);
        expect(delivered.checks[0].findings[0].message).toBe(
          "Retained formatting finding.",
        );
        expect(delivered.checks[1].error.diagnostic).toEqual(diagnostic);
        expect(delivered.checks[2].error.code).toBe("SNAPSHOT_CLEANUP_FAILED");
      } else {
        expect(stdout.join("")).toContain("temporary scan files");
      }
      const metadata = JSON.parse(
        stderr.join("").split("ZEDBEE DIAGNOSTICS\n")[1]!,
      );
      expect(metadata.cleanupFailed).toBe(true);
      expect(metadata.checks).toEqual(
        expect.arrayContaining([
          { checkId: "formatting", status: "completed", durationMs: 4 },
          { checkId: "types", status: "incomplete", durationMs: 25 },
        ]),
      );
      expect(metadata.analyzers).toEqual([{ ...diagnostic, durationMs: 25 }]);
      expect(stdout.join("") + stderr.join("")).not.toContain(
        "private-executor-secret-marker",
      );
      expect(stderr.join("").match(/SNAPSHOT CLEANUP FAILED/g)).toHaveLength(1);
      expect(stderr.join("")).not.toContain("could not complete the scan");
    },
  );

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
