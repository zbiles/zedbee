import { describe, expect, it } from "vitest";
import {
  executeScanCommand,
  selectOutputFormat,
  signalExitCode,
  type ScanCommandDependencies,
  type ScanCommandIO,
} from "../../src/commands/scan.js";
import type {
  PreparePresentationOptions,
  TerminalPresentation,
} from "../../src/reporting/presentation.js";
import type { ScanReport } from "../../src/scan/report.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

function io(
  tty: boolean,
): ScanCommandIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    width: 80,
    env: {},
    stdout,
    stderr,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
}

function dependencies(
  renderInk: ScanCommandDependencies["renderInk"] = async () => undefined,
): ScanCommandDependencies {
  return {
    resolveRepositoryRoot: async () => "/repo",
    scan: async () => createReport(),
    renderInk,
    preparePresentation: async (report) => completePresentation(report),
  };
}

function reportWithFindings(count: number): ScanReport {
  const findings = Array.from({ length: count }, (_, index) =>
    createFinding({
      id: `finding-${index + 1}`,
      rule: `rule-${index + 1}`,
      location: { file: `src/file-${index + 1}.ts`, startLine: index + 1 },
    }),
  );
  return createReport({
    outcome: "blocked",
    exitCode: 1,
    summary: {
      passed: 0,
      warnings: 0,
      failed: count,
      incomplete: 0,
      findings,
    },
    checks: [
      {
        checkId: "formatting",
        status: "completed",
        durationMs: 4,
        findings,
      },
    ],
  });
}

function completePresentation(report: ScanReport): TerminalPresentation {
  return {
    findings: report.summary.findings,
    totalFindingCount: report.summary.findings.length,
    abbreviated: false,
    warnings: [],
  };
}

describe("selectOutputFormat", () => {
  it("selects Ink only for an interactive input and output pair", () => {
    expect(selectOutputFormat("auto", true, true)).toBe("ink");
    expect(selectOutputFormat("auto", false, true)).toBe("text");
    expect(selectOutputFormat("auto", true, false)).toBe("text");
  });

  it("honors an explicit structured format", () => {
    expect(selectOutputFormat("json", true, true)).toBe("json");
    expect(selectOutputFormat("sarif", true, true)).toBe("sarif");
    expect(selectOutputFormat("sarif", false, false)).toBe("sarif");
  });
});

describe("executeScanCommand", () => {
  it("bounds automatic piped output and points to the complete report", async () => {
    const terminal = io(false);
    const report = reportWithFindings(26);
    const deps = dependencies();
    deps.scan = async () => report;
    deps.preparePresentation = async (_report, options) => {
      expect(options).toEqual({
        requestedFormat: "auto",
        selectedFormat: "text",
      });
      return {
        findings: report.summary.findings.slice(0, 25),
        totalFindingCount: 26,
        abbreviated: true,
        reportPath: "/tmp/zedbee-reports/hash/complete.json",
        maximumAge: "24h",
        warnings: [],
      };
    };

    const exitCode = await executeScanCommand(
      { cwd: "/repo", format: "auto", color: false, animations: false },
      terminal,
      deps,
    );

    const output = terminal.stdout.join("");
    expect(exitCode).toBe(1);
    expect(output).toContain("Showing 25 of 26 findings.");
    expect(output).toContain("/tmp/zedbee-reports/hash/complete.json");
    expect(output).toContain("rule-25");
    expect(output).not.toContain("rule-26");
  });

  it.each(["text", "json", "sarif"] as const)(
    "keeps explicit %s output complete while advancing maintenance once",
    async (format) => {
      const terminal = io(false);
      const report = reportWithFindings(26);
      const deps = dependencies();
      deps.scan = async () => report;
      const preparations: Omit<PreparePresentationOptions, "store">[] = [];
      deps.preparePresentation = async (preparedReport, options) => {
        preparations.push(options);
        return completePresentation(preparedReport);
      };

      const exitCode = await executeScanCommand(
        { cwd: "/repo", format, color: false, animations: false },
        terminal,
        deps,
      );

      expect(exitCode).toBe(1);
      expect(preparations).toEqual([
        { requestedFormat: format, selectedFormat: format },
      ]);
      expect(terminal.stdout.join("")).toContain("rule-26");
    },
  );

  it("prints every finding and a visible warning when report persistence fails", async () => {
    const terminal = io(false);
    const report = reportWithFindings(26);
    const deps = dependencies();
    deps.scan = async () => report;
    deps.preparePresentation = async (preparedReport) => ({
      ...completePresentation(preparedReport),
      warnings: [
        {
          code: "TEMP_REPORT_WRITE_FAILED",
          message: "The complete report could not be written.",
        },
      ],
    });

    const exitCode = await executeScanCommand(
      { cwd: "/repo", format: "auto", color: false, animations: false },
      terminal,
      deps,
    );

    const output = terminal.stdout.join("");
    expect(exitCode).toBe(1);
    expect(output).toContain("rule-26");
    expect(output).toContain("REPORT MAINTENANCE WARNING");
    expect(output).toContain("The complete report could not be written.");
  });

  it.each(["json", "sarif"] as const)(
    "writes %s maintenance warnings to stderr without changing the scan result",
    async (format) => {
      const terminal = io(false);
      const report = reportWithFindings(1);
      const deps = dependencies();
      deps.scan = async () => report;
      deps.preparePresentation = async (preparedReport) => ({
        ...completePresentation(preparedReport),
        warnings: [
          {
            code: "TEMP_REPORT_CLEANUP_FAILED",
            message: "An expired report remains.",
            path: "/tmp/zedbee-reports/hash/stuck.json",
          },
        ],
      });

      const exitCode = await executeScanCommand(
        { cwd: "/repo", format, color: false, animations: false },
        terminal,
        deps,
      );

      expect(exitCode).toBe(1);
      expect(terminal.stderr.join("")).toContain("REPORT MAINTENANCE WARNING");
      expect(terminal.stderr.join("")).toContain(
        "/tmp/zedbee-reports/hash/stuck.json",
      );
      expect(() => JSON.parse(terminal.stdout.join(""))).not.toThrow();
    },
  );

  it.each(["json", "sarif"] as const)(
    "emits no partial %s document when presentation serialization fails",
    async (format) => {
      const terminal = io(false);
      const deps = dependencies();
      deps.scan = async () => reportWithFindings(26);
      deps.preparePresentation = async () => {
        throw new TypeError("unsafe display text");
      };

      const exitCode = await executeScanCommand(
        { cwd: "/repo", format, color: false, animations: false },
        terminal,
        deps,
      );

      expect(exitCode).toBe(2);
      expect(terminal.stdout).toEqual([]);
      expect(terminal.stderr).toEqual([
        "Zedbee could not complete the scan.\n",
      ]);
    },
  );

  it("mounts Ink for auto format in a TTY and passes accessibility options", async () => {
    const terminal = io(true);
    const renders: unknown[] = [];
    const deps = dependencies(async (report, options) => {
      renders.push({ report, options });
    });

    const exitCode = await executeScanCommand(
      {
        cwd: "/repo",
        format: "auto",
        color: false,
        animations: false,
      },
      terminal,
      deps,
    );

    expect(exitCode).toBe(0);
    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({
      options: { color: false, animations: false, width: 80 },
    });
    expect(terminal.stdout).toEqual([]);
  });

  it("lets the Ink session own the scan so lifecycle events can render live", async () => {
    const terminal = io(true);
    const deps = dependencies();
    deps.scan = async () => {
      throw new Error("the completed-report path must not run");
    };
    let receivedOptions: unknown;
    deps.scanInk = async (scanOptions, renderOptions) => {
      receivedOptions = { scanOptions, renderOptions };
      return createReport();
    };

    const exitCode = await executeScanCommand(
      { cwd: "/repo", format: "auto", color: true, animations: false },
      terminal,
      deps,
    );

    expect(exitCode).toBe(0);
    expect(receivedOptions).toMatchObject({
      scanOptions: { repositoryRoot: "/repo", reportingSurface: "ink" },
      renderOptions: { color: true, animations: false, width: 80 },
    });
  });

  it("uses deterministic text when auto output is piped", async () => {
    const terminal = io(false);
    let received: unknown;
    const deps = dependencies();
    deps.scan = async (options) => {
      received = options;
      return createReport();
    };

    const exitCode = await executeScanCommand(
      {
        cwd: "/repo",
        format: "auto",
        color: true,
        animations: true,
        sourceExcerpts: "exclude",
      },
      terminal,
      deps,
    );

    expect(exitCode).toBe(0);
    expect(received).toMatchObject({
      reportingSurface: "text",
      sourceExcerpts: "exclude",
    });
    expect(terminal.stdout.join("")).toContain("BEE-UTIFUL");
    expect(terminal.stdout.join("")).not.toMatch(/\u001B\[[0-9;]*m/);
  });

  it("never mounts Ink for JSON and preserves the report exit code", async () => {
    const terminal = io(true);
    let mounted = false;
    const deps = dependencies(async () => {
      mounted = true;
    });
    let received: unknown;
    deps.scan = async (options) => {
      received = options;
      return createReport({ outcome: "blocked", exitCode: 1 });
    };

    const exitCode = await executeScanCommand(
      {
        cwd: "/repo",
        format: "json",
        color: true,
        animations: true,
        sourceExcerpts: "include",
      },
      terminal,
      deps,
    );

    expect(exitCode).toBe(1);
    expect(mounted).toBe(false);
    expect(received).toMatchObject({
      reportingSurface: "json",
      sourceExcerpts: "include",
    });
    expect(JSON.parse(terminal.stdout.join(""))).toMatchObject({ exitCode: 1 });
  });

  it("renders SARIF without Ink and preserves the report exit code", async () => {
    const terminal = io(true);
    let mounted = false;
    const deps = dependencies(async () => {
      mounted = true;
    });
    let received: unknown;
    const report = createReport({ outcome: "blocked", exitCode: 1 });
    deps.scan = async (options) => {
      received = options;
      return report;
    };

    const exitCode = await executeScanCommand(
      {
        cwd: "/repo",
        format: "sarif",
        color: true,
        animations: true,
        sourceExcerpts: "include",
      },
      terminal,
      deps,
    );

    expect(exitCode).toBe(report.exitCode);
    expect(mounted).toBe(false);
    expect(received).toMatchObject({
      reportingSurface: "sarif",
      sourceExcerpts: "include",
    });
    const stdout = terminal.stdout.join("");
    expect(JSON.parse(stdout).version).toBe("2.1.0");
    expect(stdout).toMatch(/\n$/u);
    expect(stdout).not.toMatch(/\n\n$/u);
    expect(stdout).not.toMatch(/\u001B\[[0-9;]*m/u);
    expect(terminal.stderr).toEqual([]);
  });

  it("keeps stdout empty when SARIF rendering fails", async () => {
    const terminal = io(false);
    const deps = dependencies();
    deps.scan = async () =>
      createReport({
        checks: [
          {
            checkId: "formatting",
            status: "invalid",
            durationMs: 4,
            findings: [],
          },
        ] as unknown as ReturnType<typeof createReport>["checks"],
      });

    const exitCode = await executeScanCommand(
      { cwd: "/repo", format: "sarif", color: false, animations: false },
      terminal,
      deps,
    );

    expect(exitCode).toBe(2);
    expect(terminal.stdout).toEqual([]);
    expect(terminal.stderr).toEqual(["Zedbee could not complete the scan.\n"]);
  });

  it("treats NO_COLOR as authoritative", async () => {
    const terminal = io(true);
    terminal.env.NO_COLOR = "1";
    const renders: unknown[] = [];

    await executeScanCommand(
      { cwd: "/repo", format: "ink", color: true, animations: true },
      terminal,
      dependencies(async (_report, options) => {
        renders.push(options);
      }),
    );

    expect(renders).toEqual([{ color: false, animations: true, width: 80 }]);
  });

  it("rejects configuration paths outside the repository", async () => {
    const terminal = io(false);
    let scanned = false;
    const deps = dependencies();
    deps.scan = async () => {
      scanned = true;
      return createReport();
    };

    const exitCode = await executeScanCommand(
      {
        cwd: "/repo",
        format: "text",
        color: false,
        animations: false,
        configPath: "../outside.jsonc",
      },
      terminal,
      deps,
    );

    expect(exitCode).toBe(2);
    expect(scanned).toBe(false);
    expect(terminal.stderr).toEqual([
      "Zedbee configuration must be a .jsonc file inside the repository.\n",
    ]);
  });

  it("passes a validated repository configuration path into the scan", async () => {
    const terminal = io(false);
    let receivedPath: string | undefined;
    const deps = dependencies();
    deps.scan = async (options) => {
      receivedPath = options.configPath;
      return createReport();
    };

    const exitCode = await executeScanCommand(
      {
        cwd: "/repo",
        format: "text",
        color: false,
        animations: false,
        configPath: "config/zedbee.jsonc",
      },
      terminal,
      deps,
    );

    expect(exitCode).toBe(0);
    expect(receivedPath).toBe("/repo/config/zedbee.jsonc");
  });

  it("passes the command cancellation signal into the scan", async () => {
    const terminal = io(false);
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const deps = dependencies();
    deps.scan = async (options) => {
      receivedSignal = options.signal;
      return createReport();
    };

    await executeScanCommand(
      {
        cwd: "/repo",
        format: "text",
        color: false,
        animations: false,
        signal: controller.signal,
      },
      terminal,
      deps,
    );

    expect(receivedSignal).toBe(controller.signal);
  });
});

describe("signalExitCode", () => {
  it("uses conventional interrupted process statuses", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });
});
