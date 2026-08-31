export const DEFAULT_GIT_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

export interface ScanResourcePolicy {
  readonly gitSoftTimeoutMs: number | undefined;
  readonly gitHardTimeoutMs: number | undefined;
  readonly gitOutputLimitBytes: number;
}

export interface ScanResourceOverrides {
  readonly timeout?: string;
  readonly noTimeout?: boolean;
}

type ResourceConfiguration = Readonly<{
  gitSoftTimeout?: unknown;
  gitHardTimeout?: unknown;
  gitOutputLimitBytes?: unknown;
}>;

const DURATION_PATTERN = /^([1-9][0-9]*)(ms|s|m|h)$/u;
const DURATION_MULTIPLIERS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

function configuration(value: unknown): ResourceConfiguration {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Scan resource policy must be an object.");
  }
  return value as ResourceConfiguration;
}

export function parseScanDuration(value: unknown, field: string): number {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a duration such as 30s.`);
  }
  const match = DURATION_PATTERN.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new TypeError(`${field} must be a positive whole-number duration.`);
  }
  const milliseconds = Number(match[1]) * DURATION_MULTIPLIERS[match[2]]!;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new TypeError(`${field} must resolve to a positive whole millisecond.`);
  }
  return milliseconds;
}

function optionalDuration(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : parseScanDuration(value, field);
}

function outputLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_GIT_OUTPUT_LIMIT_BYTES;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError("gitOutputLimitBytes must be a positive whole byte count.");
  }
  return value;
}

export function resolveScanResourcePolicy(
  configured: unknown,
  overrides: ScanResourceOverrides,
): ScanResourcePolicy {
  const values = configuration(configured);
  const gitSoftTimeoutMs = optionalDuration(
    values.gitSoftTimeout,
    "gitSoftTimeout",
  );
  const configuredHardTimeoutMs = optionalDuration(
    values.gitHardTimeout,
    "gitHardTimeout",
  );
  const gitHardTimeoutMs = overrides.noTimeout
    ? undefined
    : overrides.timeout === undefined
      ? configuredHardTimeoutMs
      : parseScanDuration(overrides.timeout, "timeout");
  if (
    gitSoftTimeoutMs !== undefined &&
    gitHardTimeoutMs !== undefined &&
    gitHardTimeoutMs <= gitSoftTimeoutMs
  ) {
    throw new TypeError("gitHardTimeout must be greater than gitSoftTimeout.");
  }
  return Object.freeze({
    gitSoftTimeoutMs,
    gitHardTimeoutMs,
    gitOutputLimitBytes: outputLimit(values.gitOutputLimitBytes),
  });
}
