import type { ScanReport } from "../scan/report.js";
export function projectEslintNotices(
  report: Pick<ScanReport, "checks">,
): readonly string[] {
  const notices = report.checks.filter(
    (check) => check.eslintAnalysis?.messageNotice === "permission-required",
  );
  return notices.length === 0
    ? []
    : [
        "Full project ESLint messages were requested but remain redacted. Grant separate permission in zedbee init to include source-bearing text in local reports.",
      ];
}
