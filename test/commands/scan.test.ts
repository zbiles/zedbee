import { describe, expect, it } from "vitest";
import {
  executeScanCommand,
  selectOutputFormat,
  signalExitCode,
  type ScanCommandDependencies,
  type ScanCommandIO
} from "../../src/commands/scan.js";
import { createReport } from "../helpers/scan-report.js";

function io(tty: boolean): ScanCommandIO & { stdout: string[]; stderr: string[] } {
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
    writeStderr: (value) => stderr.push(value)
  };
}

function dependencies(
  renderInk: ScanCommandDependencies["renderInk"] = async () => undefined
): ScanCommandDependencies {
  return {
    resolveRepositoryRoot: async () => "/repo",
    scan: async () => createReport(),
    renderInk
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
  });
});

describe("executeScanCommand", () => {
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
        animations: false
      },
      terminal,
      deps
    );

    expect(exitCode).toBe(0);
    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({
      options: { color: false, animations: false, width: 80 }
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
      deps
    );

    expect(exitCode).toBe(0);
    expect(receivedOptions).toMatchObject({
      scanOptions: { repositoryRoot: "/repo" },
      renderOptions: { color: true, animations: false, width: 80 }
    });
  });

  it("uses deterministic text when auto output is piped", async () => {
    const terminal = io(false);

    const exitCode = await executeScanCommand(
      { cwd: "/repo", format: "auto", color: true, animations: true },
      terminal,
      dependencies()
    );

    expect(exitCode).toBe(0);
    expect(terminal.stdout.join("")).toContain("BEE-UTIFUL");
    expect(terminal.stdout.join("")).not.toMatch(/\u001B\[[0-9;]*m/);
  });

  it("never mounts Ink for JSON and preserves the report exit code", async () => {
    const terminal = io(true);
    let mounted = false;
    const deps = dependencies(async () => {
      mounted = true;
    });
    deps.scan = async () => createReport({ outcome: "blocked", exitCode: 1 });

    const exitCode = await executeScanCommand(
      { cwd: "/repo", format: "json", color: true, animations: true },
      terminal,
      deps
    );

    expect(exitCode).toBe(1);
    expect(mounted).toBe(false);
    expect(JSON.parse(terminal.stdout.join(""))).toMatchObject({ exitCode: 1 });
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
      })
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
        configPath: "../outside.jsonc"
      },
      terminal,
      deps
    );

    expect(exitCode).toBe(2);
    expect(scanned).toBe(false);
    expect(terminal.stderr).toEqual([
      "Zedbee configuration must be a .jsonc file inside the repository.\n"
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
        configPath: "config/zedbee.jsonc"
      },
      terminal,
      deps
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
        signal: controller.signal
      },
      terminal,
      deps
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
