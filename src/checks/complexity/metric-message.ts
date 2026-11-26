import type { Linter } from "eslint";

export type ComplexityMetricName =
  "cyclomatic-complexity" | "readability-complexity";

export function parseReadabilityScore(text: string): number | undefined {
  const match = /^zedbee-readability:(\d+)$/u.exec(text);
  return match === null ? undefined : Number(match[1]);
}

export function parseComplexityMetric(
  message: Linter.LintMessage,
): { readonly name: ComplexityMetricName; readonly value: number } | undefined {
  if (message.ruleId === "zedbee/readability-complexity") {
    const value = parseReadabilityScore(message.message);
    return value === undefined
      ? undefined
      : { name: "readability-complexity", value };
  }
  if (message.ruleId === "complexity") {
    const match = /\bcomplexity of (\d+)\b/u.exec(message.message);
    return match === null
      ? undefined
      : { name: "cyclomatic-complexity", value: Number(match[1]) };
  }
  return undefined;
}
