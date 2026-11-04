export { checkLabel } from "../core/check-label.js";

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

export function findingCheckLabel(checkId: string): string {
  return FINDING_CHECK_LABELS[checkId] ?? checkId;
}
