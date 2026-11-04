const CHECK_LABELS: Readonly<Record<string, string>> = Object.freeze({
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
  return CHECK_LABELS[checkId] ?? checkId;
}
