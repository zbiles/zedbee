import { describe, expect, it } from "vitest";
import {
  executeScanCommand,
  type ScanCommandDependencies,
} from "../../src/commands/scan.js";
import {
  executeFixCommand,
  type FixCommandDependencies,
} from "../../src/commands/fix.js";
import { renderJson } from "../../src/renderers/json.js";
import { renderSarif } from "../../src/renderers/sarif.js";
import { renderFixPlanJson } from "../../src/fixes/build-plan.js";
import { FixPlanCleanupError } from "../../src/fixes/build-plan.js";
import {
  AnalysisSessionCleanupError,
  retainCleanupFailure,
} from "../../src/scan/analysis-failure.js";
import type { AnalyzerDiagnostic } from "../../src/checks/diagnostics.js";
import type { PreparedFixPlan } from "../../src/fixes/types.js";
import { createReport } from "../helpers/scan-report.js";

const diagnostic: AnalyzerDiagnostic = {
  checkId: "lint",
  operation: "collect",
  category: "abnormal-exit",
  engine: { name: "eslint", version: "9.39.5" },
  exitCode: 1,
  signal: "SIGTERM",
};
const hostileDiagnostic = {
  ...diagnostic,
  cause: "fixture-secret-marker",
  source: "fixture-secret-marker",
  environment: "/private/fixture-secret-marker",
};
const report = createReport({
  outcome: "incomplete",
  exitCode: 2,
  checks: [
    {
      checkId: "lint",
      status: "incomplete",
      durationMs: 25,
      findings: [],
      error: {
        code: "ANALYZER_FAILED",
        message: "Analyzer failed.",
        diagnostic: hostileDiagnostic,
      },
    },
  ],
});
function terminal() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    width: 80,
    env: { PRIVATE_TOKEN: "fixture-secret-marker" },
    writeStdout(value: string) {
      stdout.push(value);
    },
    writeStderr(value: string) {
      stderr.push(value);
    },
  };
}
function scanDependencies(): ScanCommandDependencies {
  return {
    resolveRepositoryRoot: async () => "/private/fixture-secret-marker",
    scan: async () => report,
    openInk: async () => {
      throw new Error("must not mount");
    },
    preparePresentation: async () => ({
      automatic: false,
      reportStatus: "not-requested",
      findings: [],
      totalFindingCount: 0,
      abbreviated: false,
      warnings: [],
    }),
  };
}
function prepared(): PreparedFixPlan {
  return {
    repositoryRoot: "/private/fixture-secret-marker",
    candidates: [],
    workingFiles: new Map(),
    temporaryReportMaxAgeMs: 1000,
    publicPlan: {
      schemaVersion: 1,
      target: "index",
      selectedChecks: ["lint"],
      exitCode: 2,
      summary: { fixes: 0, files: 0, blocking: 0, warnings: 0, skipped: 0 },
      files: [],
      items: [],
      checks: [
        {
          checkId: "lint",
          status: "incomplete",
          fixes: 0,
          issues: [
            {
              code: "ANALYZER_FAILED",
              message: "Analyzer failed.",
              diagnostic: hostileDiagnostic,
            },
          ],
        },
      ],
    },
  };
}
function fixDependencies(): FixCommandDependencies {
  return {
    resolveRepositoryRoot: async () => "/repo",
    buildFixPlan: async () => prepared(),
    applyFixPlan: async () => {
      throw new Error("must not apply");
    },
    confirm: async () => false,
    store: { maintain: async () => ({ warnings: [] }) },
  };
}

describe("safe diagnostic delivery", () => {
  it("does not copy unknown check identifiers or targets into timing diagnostics", async () => {
    const io = terminal();
    await executeScanCommand(
      {
        cwd: "/repo",
        format: "json",
        color: false,
        animations: false,
        diagnostics: true,
      },
      io,
      {
        ...scanDependencies(),
        scan: async () =>
          createReport({
            checks: [
              {
                checkId: "fixture-secret-marker",
                target: "private-target",
                status: "completed",
                findings: [],
                durationMs: 4,
              },
            ],
          }),
      },
    );
    const metadata = JSON.parse(io.stderr.join("").split("\n")[1]!);
    expect(metadata.checks).toEqual([]);
    expect(io.stderr.join("")).not.toContain("fixture-secret-marker");
    expect(io.stderr.join("")).not.toContain("private-target");
  });
  it.each(["scan", "fix"] as const)(
    "exposes useful stage timings on a successful %s without failure diagnostics",
    async (command) => {
      const io = terminal();
      const options = {
        cwd: "/repo",
        format: "json" as const,
        color: false,
        animations: false,
        diagnostics: true,
      };
      const plan = prepared();
      const exit =
        command === "scan"
          ? await executeScanCommand(options, io, {
              ...scanDependencies(),
              scan: async () => createReport(),
            })
          : await executeFixCommand({ ...options, yes: false }, io, {
              ...fixDependencies(),
              buildFixPlan: async () => ({
                ...plan,
                publicPlan: {
                  ...plan.publicPlan,
                  exitCode: 0,
                  checks: [
                    {
                      checkId: "lint",
                      status: "completed",
                      fixes: 0,
                      issues: [],
                    },
                  ],
                },
              }),
            });
      expect(exit).toBe(0);
      const metadata = JSON.parse(io.stderr.join("").split("\n")[1]!);
      expect(metadata.stages).toEqual({
        repository: expect.any(Number),
        analysis: expect.any(Number),
        report: expect.any(Number),
      });
      for (const duration of Object.values(metadata.stages))
        expect(duration).toBeGreaterThanOrEqual(0);
      expect(metadata.analyzers).toEqual([]);
      if (command === "scan")
        expect(metadata.checks).toEqual([
          { checkId: "formatting", status: "completed", durationMs: 4 },
        ]);
      expect(io.stderr.join("")).not.toContain("fixture-secret-marker");
    },
  );
  it.each(["json", "sarif"] as const)(
    "carries only allowed analyzer fields in scan %s",
    (format) => {
      const output =
        format === "json" ? renderJson(report) : renderSarif(report);
      const payload = JSON.parse(output);
      const serialized =
        format === "json"
          ? payload.checks[0].error.diagnostic
          : payload.runs[0].invocations[0].toolExecutionNotifications[0]
              .properties.diagnostic;
      expect(serialized).toEqual(diagnostic);
      expect(output).not.toContain("fixture-secret-marker");
    },
  );
  it("carries only allowed analyzer fields in the public fix plan", () => {
    const output = renderFixPlanJson(prepared().publicPlan);
    expect(JSON.parse(output).checks[0].issues[0].diagnostic).toEqual(
      diagnostic,
    );
    expect(output).not.toContain("fixture-secret-marker");
  });
  it.each([false, true])(
    "scan diagnostics opt-in %s preserves valid machine stdout",
    async (diagnostics) => {
      const io = terminal();
      expect(
        await executeScanCommand(
          {
            cwd: "/repo",
            format: "json",
            color: false,
            animations: false,
            diagnostics,
          },
          io,
          scanDependencies(),
        ),
      ).toBe(2);
      expect(JSON.parse(io.stdout.join("")).outcome).toBe("incomplete");
      const stderr = io.stderr.join("");
      if (diagnostics) {
        expect(stderr).toContain('"operation":"collect"');
        expect(stderr).toContain('"durationMs":25');
        expect(stderr).toContain('"runtime"');
      } else expect(stderr).toBe("");
      expect(stderr).not.toContain("fixture-secret-marker");
    },
  );
  it.each([false, true])(
    "fix diagnostics opt-in %s preserves valid machine stdout",
    async (diagnostics) => {
      const io = terminal();
      expect(
        await executeFixCommand(
          {
            cwd: "/repo",
            format: "json",
            color: false,
            animations: false,
            yes: false,
            diagnostics,
          },
          io,
          fixDependencies(),
        ),
      ).toBe(2);
      expect(
        JSON.parse(io.stdout.join("")).checks[0].issues[0].diagnostic,
      ).toEqual(diagnostic);
      if (diagnostics)
        expect(io.stderr.join("")).toContain('"operation":"collect"');
      else expect(io.stderr.join("")).toBe("");
      expect(io.stdout.join("") + io.stderr.join("")).not.toContain(
        "fixture-secret-marker",
      );
    },
  );
  it.each(["scan", "fix"] as const)(
    "reports %s cancellation cleanup failure without serializing the attached raw cause",
    async (command) => {
      const controller = new AbortController();
      const io = terminal();
      const fail = async () => {
        controller.abort(new Error("fixture-secret-marker"));
        if (command === "fix") {
          throw new FixPlanCleanupError("/private/fixture-secret-marker", {
            cause: controller.signal.reason,
            primaryFailure: {
              code: "CHECK_DISPATCH_FAILED",
              message: "Could not dispatch.",
              remediation: "Retry.",
            },
          });
        }
        throw retainCleanupFailure(
          controller.signal.reason,
          new AnalysisSessionCleanupError("/private/fixture-secret-marker", {
            cause: new Error("fixture-secret-marker"),
            primaryFailure: {
              code: "CHECK_DISPATCH_FAILED",
              message: "Could not dispatch.",
              remediation: "Retry.",
            },
          }),
        );
      };
      const options = {
        cwd: "/repo",
        format: "json" as const,
        color: false,
        animations: false,
        diagnostics: true,
        signal: controller.signal,
      };
      const exit =
        command === "scan"
          ? await executeScanCommand(options, io, {
              ...scanDependencies(),
              scan: fail,
            })
          : await executeFixCommand({ ...options, yes: false }, io, {
              ...fixDependencies(),
              buildFixPlan: fail,
            });
      expect(exit).toBe(2);
      expect(io.stdout).toEqual([]);
      expect(io.stderr.join("")).toContain("SNAPSHOT CLEANUP FAILED");
      expect(io.stderr.join("")).not.toContain("fixture-secret-marker");
    },
  );
  it("preserves safe working-source formatter diagnostics after applying a fix plan", async () => {
    const io = terminal();
    const plan = prepared();
    const deps = fixDependencies();
    deps.buildFixPlan = async () => ({
      ...plan,
      publicPlan: {
        ...plan.publicPlan,
        exitCode: 0,
        checks: [],
        summary: { fixes: 1, files: 1, blocking: 1, warnings: 0, skipped: 0 },
        items: [
          {
            checkId: "formatting",
            file: "src/value.ts",
            findingIds: ["f-1"],
            scope: "working-file",
            fixes: 1,
            blocking: 1,
            warnings: 0,
          },
        ],
      },
    });
    const workingDiagnostic: AnalyzerDiagnostic = {
      checkId: "formatting",
      operation: "format-working-source",
      category: "execution",
      engine: { name: "prettier" },
    };
    deps.applyFixPlan = async () => ({
      exitCode: 1,
      appliedFixes: 0,
      changedFiles: [],
      unchangedFiles: ["src/value.ts"],
      issues: [
        {
          kind: "format",
          file: "src/value.ts",
          checkIds: ["formatting"],
          message: "Could not format.",
          remediation: "Retry.",
          diagnostic: {
            ...workingDiagnostic,
            cause: "fixture-secret-marker",
          } as AnalyzerDiagnostic,
        },
      ],
    });
    expect(
      await executeFixCommand(
        {
          cwd: "/repo",
          format: "json",
          color: false,
          animations: false,
          yes: true,
          diagnostics: true,
        },
        io,
        deps,
      ),
    ).toBe(1);
    expect(JSON.parse(io.stdout.join("")).result.issues[0].diagnostic).toEqual(
      workingDiagnostic,
    );
    expect(io.stderr.join("")).toContain('"operation":"format-working-source"');
    expect(
      JSON.parse(io.stderr.join("").split("\n")[1]!).stages.apply,
    ).toBeGreaterThanOrEqual(0);
    expect(io.stdout.join("") + io.stderr.join("")).not.toContain(
      "fixture-secret-marker",
    );
  });
  it("keeps optional diagnostic stderr failure from changing a delivered scan outcome", async () => {
    const io = terminal();
    io.writeStderr = () => {
      throw new Error("fixture-secret-marker");
    };
    expect(
      await executeScanCommand(
        {
          cwd: "/repo",
          format: "json",
          color: false,
          animations: false,
          diagnostics: true,
        },
        io,
        {
          ...scanDependencies(),
          scan: async () => createReport({ outcome: "blocked", exitCode: 1 }),
        },
      ),
    ).toBe(1);
    expect(JSON.parse(io.stdout.join("")).outcome).toBe("blocked");
  });
});
