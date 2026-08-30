export type TerminalTextTone =
  "primary" | "secondary" | "reason" | "pass" | "warning" | "failure";

const FOREGROUND = Object.freeze({
  primary: 231,
  secondary: 145,
  reason: 221,
  pass: 115,
  warning: 221,
  failure: 210,
} satisfies Readonly<Record<TerminalTextTone, number>>);

export function terminalText(
  value: string,
  tone: TerminalTextTone,
  color: boolean,
): string {
  if (!color || value.length === 0) return value;
  return `\u001b[38;5;${FOREGROUND[tone]}m${value}\u001b[39m`;
}

export function terminalColorEnabled(
  requested: boolean,
  stdoutIsTTY: boolean,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    requested &&
    stdoutIsTTY &&
    environment.NO_COLOR === undefined &&
    environment.TERM !== "dumb" &&
    environment.CI === undefined
  );
}
