import type { CheckId } from "./check-ids.js";

const CHECK_LABELS: Readonly<Record<CheckId, string>> = Object.freeze({
  formatting: "Formatting",
  lint: "Lint",
  types: "TypeScript",
  cyclomaticComplexity: "Cyclomatic complexity",
  readabilityComplexity: "Readability complexity",
  structuralSecurity: "Structural security",
  secrets: "Secrets",
  duplication: "Duplication",
  dependencyArchitecture: "Dependency architecture",
  deadCode: "Dead code",
  reactCorrectness: "React correctness",
  reactAccessibility: "React accessibility",
  vulnerabilities: "Vulnerabilities",
});

export function checkLabel(checkId: string): string {
  return Object.hasOwn(CHECK_LABELS, checkId)
    ? CHECK_LABELS[checkId as CheckId]
    : checkId;
}
