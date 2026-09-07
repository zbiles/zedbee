#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Argument, Command, CommanderError, Option } from "commander";
import { ZEDBEE_VERSION } from "./core/package-version.js";
import { terminalColorEnabled } from "./renderers/terminal-style.js";
import { getUpdateNotice, renderUpdateNotice } from "./updates/notification.js";
import type { UpdateNotice } from "./updates/metadata.js";
import { executeChecksCommand } from "./commands/checks.js";
import { executeDoctorCommand } from "./commands/doctor.js";
import { executeFixCommand } from "./commands/fix.js";
import { executeInitCommand, parseCheckSelection } from "./commands/init.js";
import type { CheckId, ProfileId } from "./config/schema.js";
import { FIXABLE_CHECK_IDS, type FixableCheckId } from "./fixes/types.js";
import type { InitHookChoice, InitOsvUnavailable } from "./init/types.js";
import type { RequestedOutputFormat } from "./scan/reporting-options.js";
import {
  executeScanCommand,
  normalizeTerminalWidth,
  selectOutputFormat,
  signalExitCode,
} from "./commands/scan.js";

interface CommanderScanOptions {
  diagnostics?: boolean;
  format: RequestedOutputFormat;
  base?: string;
  config?: string;
  includeSource?: boolean;
  source: boolean;
  color: boolean;
  animations: boolean;
  timeout?: string | false;
}

interface CommanderChecksOptions {
  format: "auto" | "text" | "json";
  config?: string;
  color: boolean;
}

interface CommanderDoctorOptions {
  format: "auto" | "text" | "json";
  config?: string;
  color: boolean;
}

interface CommanderInitOptions {
  profile: ProfileId;
  hook: InitHookChoice;
  checks?: readonly CheckId[];
  osvUnavailable: InitOsvUnavailable;
  yes: boolean;
  format: "text" | "json";
  color: boolean;
  animations: boolean;
}

interface CommanderFixOptions {
  diagnostics?: boolean;
  format: "auto" | "text" | "json";
  config?: string;
  yes: boolean;
  color: boolean;
  animations: boolean;
}

export function scanTimeoutOverrides(
  argv: readonly string[],
  timeout: string | false | undefined,
): Readonly<{ timeout?: string; noTimeout?: true }> {
  if (argv.includes("--no-timeout")) {
    return { noTimeout: true };
  }
  return typeof timeout === "string" ? { timeout } : {};
}

export interface CliDependencies {
  readonly executeScanCommand?: typeof executeScanCommand;
  readonly executeFixCommand?: typeof executeFixCommand;
}

export async function runCli(
  argv: readonly string[] = process.argv,
  dependencies: CliDependencies = {},
): Promise<number> {
  const program = new Command()
    .name("zedbee")
    .description("Diff-aware pre-commit scanning for JavaScript and TypeScript")
    .showHelpAfterError()
    .exitOverride();
  let exitCode = 0;
  let updateNotice: UpdateNotice | undefined;
  let updateColor = false;
  let updateIndented = false;
  program.hook("preAction", (_program, action) => {
    const options = action.opts();
    updateIndented =
      action.name() === "scan" &&
      selectOutputFormat(
        options.format as RequestedOutputFormat,
        process.stdin.isTTY === true,
        process.stdout.isTTY === true,
        normalizeTerminalWidth(process.stdout.columns),
        process.env,
      ) === "ink";
    updateNotice = getUpdateNotice({
      env: process.env,
      isTTY: process.stdout.isTTY === true,
      format: String(options.format ?? "auto"),
      currentVersion: ZEDBEE_VERSION,
      nodeVersion: process.versions.node,
    });
    updateColor = terminalColorEnabled(
      options.color !== false,
      process.stdout.isTTY === true,
      process.env,
    );
  });
  let interrupted: "SIGINT" | "SIGTERM" | undefined;
  const controller = new AbortController();
  const interrupt = (signal: "SIGINT" | "SIGTERM"): void => {
    interrupted = signal;
    controller.abort();
  };
  const onSigint = (): void => interrupt("SIGINT");
  const onSigterm = (): void => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  program
    .command("init")
    .description("preview and safely initialize Zedbee policy and hooks")
    .addOption(
      new Option("--profile <profile>", "initial check profile")
        .choices(["fast", "recommended", "thorough"])
        .default("recommended"),
    )
    .addOption(
      new Option(
        "--checks <ids>",
        "comma-separated enabled check IDs (non-interactive check toggles)",
      ).argParser(parseCheckSelection),
    )
    .addOption(
      new Option("--hook <hook>", "pre-commit integration")
        .choices([
          "auto",
          "husky",
          "lefthook",
          "simple-git-hooks",
          "raw",
          "none",
        ])
        .default("auto"),
    )
    .addOption(
      new Option(
        "--osv-unavailable <policy>",
        "commit policy when the online OSV service is unavailable",
      )
        .choices(["block", "warn"])
        .default("block"),
    )
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["text", "json"])
        .default("text"),
    )
    .option(
      "--yes",
      "apply the exact proposal without an interactive prompt",
      false,
    )
    .option("--no-color", "disable color")
    .option("--no-animations", "disable animations")
    .action(async (options: CommanderInitOptions) => {
      exitCode = await executeInitCommand(
        {
          cwd: process.cwd(),
          profile: options.profile,
          hook: options.hook,
          ...(options.checks === undefined ? {} : { checks: options.checks }),
          osvUnavailable: options.osvUnavailable,
          yes: options.yes,
          format: options.format,
          color: options.color,
          animations: options.animations,
        },
        {
          stdinIsTTY: process.stdin.isTTY === true,
          stdoutIsTTY: process.stdout.isTTY === true,
          width: process.stdout.columns ?? 80,
          env: process.env,
          writeStdout: (value) => process.stdout.write(value),
          writeStderr: (value) => process.stderr.write(value),
        },
      );
    });

  program
    .command("scan")
    .description("scan the selected index or committed target")
    .option(
      "--base <ref>",
      "scan committed HEAD changes since the unique merge base with this ref",
    )
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["auto", "ink", "text", "json", "sarif"])
        .default("auto"),
    )
    .addOption(
      new Option(
        "--include-source",
        "include exact selected-target source excerpts",
      ).conflicts("source"),
    )
    .addOption(
      new Option(
        "--no-source",
        "omit exact selected-target source excerpts",
      ).conflicts("includeSource"),
    )
    .option("--config <path>", "path to a JSONC Zedbee configuration")
    .option("--timeout <duration>", "set the Git hard timeout for this scan")
    .option(
      "--diagnostics",
      "write safe analyzer and runtime diagnostics to stderr",
    )
    .addOption(
      new Option("--no-timeout", "disable configured Git hard timeouts"),
    )
    .option("--no-color", "disable color")
    .option("--no-animations", "disable animations")
    .action(async (options: CommanderScanOptions) => {
      exitCode = await (dependencies.executeScanCommand ?? executeScanCommand)(
        {
          cwd: process.cwd(),
          format: options.format,
          color: options.color,
          animations: options.animations,
          ...(options.base === undefined ? {} : { baseRef: options.base }),
          ...(options.config === undefined
            ? {}
            : { configPath: options.config }),
          ...(options.includeSource === true
            ? { sourceExcerpts: "include" as const }
            : options.source === false
              ? { sourceExcerpts: "exclude" as const }
              : {}),
          ...scanTimeoutOverrides(argv, options.timeout),
          ...(options.diagnostics === true ? { diagnostics: true } : {}),
          signal: controller.signal,
        },
        {
          stdinIsTTY: process.stdin.isTTY === true,
          stdoutIsTTY: process.stdout.isTTY === true,
          width: normalizeTerminalWidth(process.stdout.columns),
          env: process.env,
          writeStdout: (value) => process.stdout.write(value),
          writeStderr: (value) => process.stderr.write(value),
        },
      );
    });

  program
    .command("fix")
    .description("preview and apply managed fixes to working files")
    .addArgument(
      new Argument("[check]", "managed fix check selector").choices([
        ...FIXABLE_CHECK_IDS,
      ]),
    )
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["auto", "text", "json"])
        .default("auto"),
    )
    .option("--config <path>", "path to a JSONC Zedbee configuration")
    .option("--yes", "apply the exact plan without confirmation", false)
    .option(
      "--diagnostics",
      "write safe analyzer and runtime diagnostics to stderr",
    )
    .option("--no-color", "disable color")
    .option("--no-animations", "disable animations")
    .action(
      async (
        check: FixableCheckId | undefined,
        options: CommanderFixOptions,
      ) => {
        exitCode = await (dependencies.executeFixCommand ?? executeFixCommand)(
          {
            cwd: process.cwd(),
            ...(check === undefined ? {} : { check }),
            yes: options.yes,
            ...(options.diagnostics === true ? { diagnostics: true } : {}),
            format: options.format,
            color: options.color,
            animations: options.animations,
            ...(options.config === undefined
              ? {}
              : { configPath: options.config }),
            signal: controller.signal,
          },
          {
            stdinIsTTY: process.stdin.isTTY === true,
            stdoutIsTTY: process.stdout.isTTY === true,
            width: normalizeTerminalWidth(process.stdout.columns),
            env: process.env,
            writeStdout: (value) => process.stdout.write(value),
            writeStderr: (value) => process.stderr.write(value),
          },
        );
      },
    );

  program
    .command("checks")
    .description("describe configured checks and their applicability")
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["auto", "text", "json"])
        .default("auto"),
    )
    .option("--config <path>", "path to a JSONC Zedbee configuration")
    .option("--no-color", "disable color")
    .action(async (options: CommanderChecksOptions) => {
      const result = await executeChecksCommand(
        {
          cwd: process.cwd(),
          format: options.format,
          color: options.color,
          ...(options.config === undefined
            ? {}
            : { configPath: options.config }),
        },
        {
          stdoutIsTTY: process.stdout.isTTY === true,
          width: process.stdout.columns ?? 80,
          env: process.env,
          writeStdout: (value) => process.stdout.write(value),
          writeStderr: (value) => process.stderr.write(value),
        },
      );
      exitCode = result.exitCode;
    });

  program
    .command("doctor")
    .description("diagnose Zedbee setup without running a scan")
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["auto", "text", "json"])
        .default("auto"),
    )
    .option("--config <path>", "path to a JSONC Zedbee configuration")
    .option("--no-color", "disable color")
    .action(async (options: CommanderDoctorOptions) => {
      const result = await executeDoctorCommand(
        {
          cwd: process.cwd(),
          format: options.format,
          color: options.color,
          environment: process.env,
          ...(options.config === undefined
            ? {}
            : { configPath: options.config }),
        },
        {
          stdoutIsTTY: process.stdout.isTTY === true,
          width: process.stdout.columns ?? 80,
          env: process.env,
          writeStdout: (value) => process.stdout.write(value),
          writeStderr: (value) => process.stderr.write(value),
        },
      );
      exitCode = result.exitCode;
    });

  try {
    await program.parseAsync([...argv]);
    if (interrupted === undefined && updateNotice !== undefined) {
      try {
        process.stdout.write(
          renderUpdateNotice(updateNotice, {
            cwd: process.cwd(),
            color: updateColor,
            indent: updateIndented,
          }),
        );
      } catch {
        /* A notice cannot change a command's result. */
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  return interrupted === undefined ? exitCode : signalExitCode(interrupted);
}

export async function main(
  argv: readonly string[] = process.argv,
): Promise<number> {
  try {
    return await runCli(argv);
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await main();
}
