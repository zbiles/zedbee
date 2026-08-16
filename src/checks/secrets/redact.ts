import { gitleaksReportSchema } from "./gitleaks-schema.js";

export interface RedactedGitleaksFinding {
  readonly ruleId: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

const INVALID_REPORT = "Gitleaks returned an invalid report";

/**
 * The only boundary where secret-bearing Gitleaks JSON is accepted. Callers get
 * a deliberately narrow value that cannot carry matches, source, authorship,
 * entropy, commit data, or upstream fingerprints any farther into Zedbee.
 */
export function parseAndRedactGitleaksReport(
  rawReport: string,
): readonly RedactedGitleaksFinding[] {
  try {
    const parsed: unknown = JSON.parse(rawReport);
    rawReport = "";
    const findings = gitleaksReportSchema.parse(parsed);
    return Object.freeze(
      findings.map((finding) =>
        Object.freeze({
          ruleId: finding.RuleID,
          file: finding.File.replaceAll("\\", "/"),
          startLine: finding.StartLine,
          endLine: finding.EndLine,
          startColumn: finding.StartColumn,
          endColumn: finding.EndColumn,
        }),
      ),
    );
  } catch {
    rawReport = "";
    throw new TypeError(INVALID_REPORT);
  }
}
