const DURATION = /^([1-9][0-9]{0,7})([mhd])$/u;
const MULTIPLIERS = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

function parseDuration(value: string): {
  readonly amount: number;
  readonly unit: keyof typeof MULTIPLIERS;
  readonly milliseconds: number;
} {
  const match = DURATION.exec(value);
  if (match === null) {
    throw new TypeError("Invalid temporary report maximum age");
  }
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof MULTIPLIERS;
  const milliseconds = amount * MULTIPLIERS[unit];
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError("Invalid temporary report maximum age");
  }
  return { amount, unit, milliseconds };
}

export function parseTemporaryReportMaxAge(value: string): number {
  return parseDuration(value).milliseconds;
}

export function formatTemporaryReportMaxAge(value: string): string {
  const { amount, unit } = parseDuration(value);
  const labels = {
    m: amount === 1 ? "minute" : "minutes",
    h: amount === 1 ? "hour" : "hours",
    d: amount === 1 ? "day" : "days",
  } as const;
  return `${amount} ${labels[unit]}`;
}
