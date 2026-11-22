export const CHECK_IDS = [
  "formatting",
  "lint",
  "types",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "structuralSecurity",
  "secrets",
  "duplication",
  "dependencyArchitecture",
  "deadCode",
  "reactCorrectness",
  "reactAccessibility",
  "vulnerabilities",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];
