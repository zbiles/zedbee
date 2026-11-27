import type {
  RequestedOutputFormat,
  ReportingSurface as OutputFormat,
} from "../scan/reporting-options.js";

export function selectOutputFormat(
  requested: RequestedOutputFormat,
  _stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
  width?: number,
  env: Readonly<Record<string, string | undefined>> = {},
): OutputFormat {
  if (requested !== "auto") {
    return requested;
  }
  return usesLinearAutomaticOutput(stdoutIsTTY, width, env) ? "text" : "ink";
}

function positiveTerminalWidth(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : undefined;
}

export function normalizeTerminalWidth(value: unknown): number {
  return positiveTerminalWidth(value) ?? 80;
}

function isTruthyEnvironmentValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return !["", "0", "false", "no", "off"].includes(normalized);
}

function usesLinearAutomaticOutput(
  stdoutIsTTY: boolean,
  width: number | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const knownWidth = positiveTerminalWidth(width);
  return (
    !stdoutIsTTY ||
    (knownWidth !== undefined && knownWidth < 80) ||
    isTruthyEnvironmentValue(env.CI) ||
    env.TERM === "dumb" ||
    env.INK_SCREEN_READER === "true"
  );
}

export function signalExitCode(signal: "SIGINT" | "SIGTERM"): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}
