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

const FINDING_CHECK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  formatting: "Prettier",
  lint: "ESLint",
  types: "TypeScript",
  cyclomaticComplexity: "ESLint",
  readabilityComplexity: "ESLint",
  structuralSecurity: "ast-grep",
  secrets: "Secretlint",
  duplication: "jscpd",
  dependencyArchitecture: "dependency-cruiser",
  deadCode: "Knip",
  reactCorrectness: "ESLint",
  reactAccessibility: "ESLint",
  vulnerabilities: "OSV",
  zedbee: "Zedbee",
});

export function checkLabel(checkId: string): string {
  return CHECK_LABELS[checkId] ?? checkId;
}

export function findingCheckLabel(checkId: string): string {
  return FINDING_CHECK_LABELS[checkId] ?? checkId;
}
