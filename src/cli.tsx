#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { executeChecksCommand } from "./commands/checks.js";
import { executeDoctorCommand } from "./commands/doctor.js";
import { executeInitCommand, parseCheckSelection } from "./commands/init.js";
import type { CheckId, ProfileId } from "./config/schema.js";
import type { InitHookChoice, InitOsvUnavailable } from "./init/types.js";
import {
  executeScanCommand,
  signalExitCode,
  type RequestedOutputFormat,
} from "./commands/scan.js";

interface CommanderScanOptions {
  format: RequestedOutputFormat;
  config?: string;
  includeSource?: boolean;
  source: boolean;
  color: boolean;
  animations: boolean;
}

interface CommanderReportOptions {
  format: "text" | "json";
  config?: string;
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

export async function main(
  argv: readonly string[] = process.argv,
): Promise<number> {
  const program = new Command()
    .name("zedbee")
    .description("Diff-aware pre-commit scanning for JavaScript and TypeScript")
    .showHelpAfterError();
  let exitCode = 0;
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
    .description("scan the exact staged Git snapshot")
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["auto", "ink", "text", "json"])
        .default("auto"),
    )
    .addOption(
      new Option(
        "--include-source",
        "include exact staged source excerpts",
      ).conflicts("source"),
    )
    .addOption(
      new Option("--no-source", "omit exact staged source excerpts").conflicts(
        "includeSource",
      ),
    )
    .option("--config <path>", "path to a JSONC Zedbee configuration")
    .option("--no-color", "disable color")
    .option("--no-animations", "disable animations")
    .action(async (options: CommanderScanOptions) => {
      exitCode = await executeScanCommand(
        {
          cwd: process.cwd(),
          format: options.format,
          color: options.color,
          animations: options.animations,
          ...(options.config === undefined
            ? {}
            : { configPath: options.config }),
          ...(options.includeSource === true
            ? { sourceExcerpts: "include" as const }
            : options.source === false
              ? { sourceExcerpts: "exclude" as const }
              : {}),
          signal: controller.signal,
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
    .command("checks")
    .description("describe configured checks and their applicability")
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["text", "json"])
        .default("text"),
    )
    .option("--config <path>", "path to a JSONC Zedbee configuration")
    .action(async (options: CommanderReportOptions) => {
      const result = await executeChecksCommand(
        {
          cwd: process.cwd(),
          format: options.format,
          ...(options.config === undefined
            ? {}
            : { configPath: options.config }),
        },
        {
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
        .choices(["text", "json"])
        .default("text"),
    )
    .option("--config <path>", "path to a JSONC Zedbee configuration")
    .action(async (options: CommanderReportOptions) => {
      const result = await executeDoctorCommand(
        {
          cwd: process.cwd(),
          format: options.format,
          environment: process.env,
          ...(options.config === undefined
            ? {}
            : { configPath: options.config }),
        },
        {
          writeStdout: (value) => process.stdout.write(value),
          writeStderr: (value) => process.stderr.write(value),
        },
      );
      exitCode = result.exitCode;
    });

  try {
    await program.parseAsync([...argv]);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  return interrupted === undefined ? exitCode : signalExitCode(interrupted);
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await main();
}
