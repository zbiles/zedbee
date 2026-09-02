import { render } from "ink-testing-library";
import { resolve } from "node:path";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import {
  executeScanCommand,
  normalizeTerminalWidth,
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
import { ScanResultDashboard } from "../../src/ui/scan-result-dashboard.js";
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

function reportWithMixedFindings(count: number): ScanReport {
  const findings = Array.from({ length: count }, (_, index) =>
    createFinding({
      id: `finding-${index + 1}`,
      rule: `rule-${index + 1}`,
      severity: index % 2 === 0 ? "error" : "warning",
      location: { file: `src/file-${index + 1}.ts`, startLine: index + 1 },
    }),
  );
  const failed = findings.filter(({ severity }) => severity === "error").length;
  const warnings = findings.length - failed;
  return createReport({
    outcome: "blocked",
    exitCode: 1,
    summary: {
      passed: 0,
      warnings,
      failed,
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
    automatic: false,
    reportStatus: "not-requested",
    findings: report.summary.findings,
    totalFindingCount: report.summary.findings.length,
    abbreviated: false,
    warnings: [],
  };
}

function automaticPresentation(
  report: ScanReport,
  overrides: Partial<TerminalPresentation> = {},
): TerminalPresentation {
  const reportAvailable = overrides.reportStatus !== "unavailable";
  return {
    automatic: true,
    reportStatus: "available",
    findings: report.summary.findings,
    totalFindingCount: report.summary.findings.length,
    abbreviated: false,
    ...(reportAvailable
      ? {
          reportPath: "/tmp/zedbee-reports/hash/complete.json",
          maximumAge: "24h",
        }
      : {}),
    warnings: [],
    ...overrides,
  };
}

function renderAutomaticInk(
  terminal: ScanCommandIO,
): ScanCommandDependencies["renderInk"] {
  return async (report, options, presentation) => {
    expect(options).toEqual({
      requestedFormat: "auto",
      color: false,
      animations: false,
      width: 120,
    });
    expect(presentation?.automatic).toBe(true);
    if (presentation === undefined) {
      throw new TypeError("Automatic Ink rendering requires a presentation");
    }
    const app = render(
      createElement(ScanResultDashboard, {
        report,
        presentation,
        width: options.width,
        color: options.color,
      }),
    );
    try {
      terminal.writeStdout(`${app.lastFrame() ?? ""}\n`);
    } finally {
      app.unmount();
    }
  };
}

describe("selectOutputFormat", () => {
  it.each([
    ["redirected stdout", true, false, 120, {}],
    ["narrow terminal", true, true, 79, {}],
    ["CI true", true, true, 120, { CI: "true" }],
    ["CI one", true, true, 120, { CI: "1" }],
    ["CI provider value", true, true, 120, { CI: "buildkite" }],
    ["dumb terminal", true, true, 120, { TERM: "dumb" }],
    ["screen-reader terminal", true, true, 120, { INK_SCREEN_READER: "true" }],
  ] as const)(
    "selects text for automatic output in a %s",
    (_name, stdinIsTTY, stdoutIsTTY, width, env) => {
      expect(
        selectOutputFormat("auto", stdinIsTTY, stdoutIsTTY, width, env),
      ).toBe("text");
    },
  );

  it("selects Ink for automatic output in a wide ordinary TTY", () => {
    expect(selectOutputFormat("auto", true, true, 120, {})).toBe("ink");
    expect(selectOutputFormat("auto", false, true, 120, {})).toBe("ink");
  });

  it("treats invalid terminal widths and false CI values as unknown", () => {
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        selectOutputFormat("auto", true, true, width, { CI: "false" }),
      ).toBe("ink");
    }
  });

  it.each(["ink", "text", "json", "sarif"] as const)(
    "never downgrades explicit %s output",
    (format) => {
      expect(
        selectOutputFormat(format, false, false, 20, {
          CI: "true",
          TERM: "dumb",
          INK_SCREEN_READER: "true",
        }),
      ).toBe(format);
    },
  );
});

describe("normalizeTerminalWidth", () => {
  it("accepts positive finite integers and uses the ordinary width otherwise", () => {
    expect(normalizeTerminalWidth(79)).toBe(79);
    for (const value of [undefined, 0, -1, 79.5, Number.NaN, Infinity]) {
      expect(normalizeTerminalWidth(value)).toBe(80);
    }
  });
});

describe("executeScanCommand", () => {
  it("passes the requested base unchanged into the scan", async () => {
    const terminal = io(false);
    let receivedBase: string | undefined;
    const deps = dependencies();
    deps.scan = async (options) => {
      receivedBase = options.baseRef;
      return createReport();
    };

    const exitCode = await executeScanCommand(
      {
        cwd: "/repo",
        format: "text",
        color: false,
        animations: false,
        baseRef: " origin/main ",
      },
      terminal,
      deps,
    );

    expect(exitCode).toBe(0);
    expect(receivedBase).toBe(" origin/main ");
  });

  it.each([
    ["text", false],
    ["ink", true],
  ] as const)(
    "delivers a successful zero-finding automatic %s result with a report path",
    async (selectedFormat, tty) => {
      const terminal = io(tty);
      terminal.width = tty ? 120 : 80;
      const report = createReport();
      const deps = dependencies(renderAutomaticInk(terminal));
      deps.preparePresentation = async (_report, options) => {
        expect(options).toEqual({
          requestedFormat: "auto",
          selectedFormat,
        });
        return automaticPresentation(report);
      };

      const exitCode = await executeScanCommand(
        { cwd: "/repo", format: "auto", color: false, animations: false },
        terminal,
        deps,
      );

      const output = terminal.stdout.join("");
      expect(exitCode).toBe(0);
      expect(output).toContain("COMMIT ALLOWED");
      expect(output.match(/COMPLETE REPORT/gu)).toHaveLength(2);
      expect(output.match(/complete\.json/gu)).toHaveLength(2);
      if (selectedFormat === "ink") {
        expect(output).toContain("▀▀▀▀█ █▀▀▀▀");
      } else {
        expect(output).not.toContain("▀▀▀▀█ █▀▀▀▀");
      }
    },
  );

  it.each([
    ["text", false],
    ["ink", true],
  ] as const)(
    "bounds 26 mixed findings in automatic %s output and points to the complete report",
    async (selectedFormat, tty) => {
      const terminal = io(tty);
      terminal.width = tty ? 120 : 80;
      const report = reportWithMixedFindings(26);
      const deps = dependencies(renderAutomaticInk(terminal));
      deps.scan = async () => report;
      deps.preparePresentation = async (_report, options) => {
        expect(options).toEqual({
          requestedFormat: "auto",
          selectedFormat,
        });
        return {
          automatic: true,
          reportStatus: "available",
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
      if (selectedFormat === "ink") {
        expect(output).toContain("▀▀▀▀█ █▀▀▀▀");
      } else {
        expect(output).not.toContain("▀▀▀▀█ █▀▀▀▀");
      }
    },
  );

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

  it.each([
    ["text", false],
    ["ink", true],
  ] as const)(
    "prints every finding and fixed automatic %s notices when report persistence fails",
    async (selectedFormat, tty) => {
      const terminal = io(tty);
      terminal.width = tty ? 120 : 80;
      const baseReport = reportWithMixedFindings(26);
      const report: ScanReport = {
        ...baseReport,
        presentationPolicy: {
          ...baseReport.presentationPolicy,
          agentGuidance: {
            opening: "Read the configured report path.",
            nextStep: "Continue from the configured report path.",
          },
        },
      };
      const deps = dependencies(renderAutomaticInk(terminal));
      deps.scan = async () => report;
      deps.preparePresentation = async () =>
        automaticPresentation(report, {
          reportStatus: "unavailable",
          abbreviated: false,
          completeOutputFallback: true,
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
      expect(output).toContain("rule-1");
      expect(output).toContain("rule-26");
      expect(output.match(/REPORT UNAVAILABLE/gu)).toHaveLength(2);
      expect(output).toContain("REPORT WARNINGS");
      expect(output).toContain("The complete report could not be written.");
      expect(output).not.toContain("AGENT GUIDANCE");
      expect(output).not.toContain("AGENT NEXT STEP");
      expect(output).not.toContain("complete.json");
      if (selectedFormat === "ink") {
        expect(output).toContain("▀▀▀▀█ █▀▀▀▀");
      } else {
        expect(output).not.toContain("▀▀▀▀█ █▀▀▀▀");
      }
    },
  );

  it.each([
    ["text", false],
    ["ink", true],
  ] as const)(
    "retains automatic %s guidance and report paths when cleanup warns",
    async (selectedFormat, tty) => {
      const terminal = io(tty);
      terminal.width = tty ? 120 : 80;
      const report = createReport({
        presentationPolicy: {
          terminalFindingLimit: 25,
          temporaryReportMaxAge: "24h",
          persistSourceExcerpts: false,
          agentGuidance: {
            opening: "Read this report.",
            nextStep: "Continue from this report.",
          },
        },
      });
      const deps = dependencies(renderAutomaticInk(terminal));
      deps.scan = async () => report;
      deps.preparePresentation = async () =>
        automaticPresentation(report, {
          warnings: [
            {
              code: "TEMP_REPORT_CLEANUP_FAILED",
              message: "An expired report remains.",
              path: "/tmp/zedbee-reports/hash/expired.json",
            },
          ],
        });

      const exitCode = await executeScanCommand(
        { cwd: "/repo", format: "auto", color: false, animations: false },
        terminal,
        deps,
      );

      const output = terminal.stdout.join("");
      expect(exitCode).toBe(0);
      expect(output).toContain("AGENT GUIDANCE");
      expect(output).toContain("AGENT NEXT STEP");
      expect(output.match(/complete\.json/gu)).toHaveLength(2);
      expect(output).toContain("REPORT WARNINGS");
      expect(output).toContain("expired.json");
      if (selectedFormat === "ink") {
        expect(output).toContain("▀▀▀▀█ █▀▀▀▀");
      } else {
        expect(output).not.toContain("▀▀▀▀█ █▀▀▀▀");
      }
    },
  );

  it.each([
    ["blocked", "text", 1, false],
    ["blocked", "ink", 1, true],
    ["incomplete", "text", 2, false],
    ["incomplete", "ink", 2, true],
  ] as const)(
    "preserves canonical exit after automatic report failure for an %s scan in automatic %s",
    async (outcome, selectedFormat, expectedExitCode, tty) => {
      const terminal = io(tty);
      terminal.width = tty ? 120 : 80;
      const report: ScanReport = {
        ...reportWithFindings(1),
        outcome,
        exitCode: expectedExitCode,
      };
      const deps = dependencies(renderAutomaticInk(terminal));
      deps.scan = async () => report;
      deps.preparePresentation = async (_report, options) => {
        expect(options).toEqual({
          requestedFormat: "auto",
          selectedFormat,
        });
        return automaticPresentation(report, {
          reportStatus: "unavailable",
          completeOutputFallback: true,
          warnings: [
            {
              code: "TEMP_REPORT_WRITE_FAILED",
              message: "The complete report could not be written.",
            },
          ],
        });
      };

      const exitCode = await executeScanCommand(
        { cwd: "/repo", format: "auto", color: false, animations: false },
        terminal,
        deps,
      );

      expect(exitCode).toBe(expectedExitCode);
      const output = terminal.stdout.join("");
      expect(output).toContain("REPORT UNAVAILABLE");
      if (selectedFormat === "ink") {
        expect(output).toContain("▀▀▀▀█ █▀▀▀▀");
      } else {
        expect(output).not.toContain("▀▀▀▀█ █▀▀▀▀");
      }
    },
  );

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

  it.each(["text", "json", "sarif"] as const)(
    "writes a Git soft-timeout warning to stderr for %s without contaminating stdout",
    async (format) => {
      const terminal = io(false);
      const deps = dependencies();
      deps.scan = async (options) => {
        options.onEvent?.({
          type: "git-soft-timeout",
          checkId: "zedbee",
          target: ".",
          timestamp: 1,
        });
        return createReport();
      };

      const exitCode = await executeScanCommand(
        { cwd: "/repo", format, color: false, animations: false },
        terminal,
        deps,
      );

      expect(exitCode).toBe(0);
      expect(terminal.stderr.join("")).toContain("GIT SOFT TIMEOUT");
      if (format !== "text") {
        expect(() => JSON.parse(terminal.stdout.join(""))).not.toThrow();
      }
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
      options: {
        requestedFormat: "auto",
        color: false,
        animations: false,
        width: 80,
      },
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
      renderOptions: {
        requestedFormat: "auto",
        color: true,
        animations: false,
        width: 80,
      },
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

    expect(renders).toEqual([
      {
        requestedFormat: "ink",
        color: false,
        animations: true,
        width: 80,
      },
    ]);
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
    expect(receivedPath).toBe(resolve("/repo", "config/zedbee.jsonc"));
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

describe("runCli", () => {
  it("describes index/base targets and selected-target source excerpts", async () => {
    const stdout: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((value) => {
        stdout.push(String(value));
        return true;
      });
    try {
      await expect(
        runCli(["node", "zedbee", "scan", "--help"]),
      ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
    } finally {
      write.mockRestore();
    }
    const help = stdout.join("");

    expect(help).toContain("scan the selected index or committed target");
    expect(help).toContain("include exact selected-target source excerpts");
    expect(help).not.toContain("scan the exact staged Git snapshot");
  });

  it("passes scan --base to the scan command unchanged", async () => {
    let received: unknown;

    const exitCode = await runCli(
      ["node", "zedbee", "scan", "--base", " origin/main ", "--format", "text"],
      {
        executeScanCommand: async (options) => {
          received = options;
          return 0;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(received).toMatchObject({ baseRef: " origin/main " });
  });

  it.each(["fix", "checks", "doctor", "init"])(
    "rejects --base on %s as an unknown option",
    async (command) => {
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        await expect(
          runCli(["node", "zedbee", command, "--base", "origin/main"], {
            executeScanCommand: async () => 0,
          }),
        ).rejects.toMatchObject({ code: "commander.unknownOption" });
      } finally {
        stderr.mockRestore();
      }
    },
  );
});

describe("signalExitCode", () => {
  it("uses conventional interrupted process statuses", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });
});
