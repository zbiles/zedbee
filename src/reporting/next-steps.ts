import type { ScanReport } from "../scan/report.js";
import { opaqueTemporaryReportPath } from "./report-path.js";

export interface NextStepsInput {
  readonly outcome: ScanReport["outcome"];
  readonly shown: number;
  readonly total: number;
  readonly reportPath: string;
  readonly expiresAfterRuns: number;
}

function outcomeInstructions(
  outcome: ScanReport["outcome"],
): readonly string[] {
  if (outcome === "blocked") {
    return [
      "Fix every blocking finding, stage the changes, then run Zedbee again.",
    ];
  }
  if (outcome === "incomplete") {
    return [
      "Restore every required incomplete check, then run Zedbee again.",
      "Do not treat the scan as clean.",
    ];
  }
  return [
    "Review every warning, make any appropriate changes, and run Zedbee again when changes are made.",
  ];
}

export function nextStepsLines(input: NextStepsInput): readonly string[] {
  const runLabel = input.expiresAfterRuns === 1 ? "run" : "runs";
  return Object.freeze([
    "NEXT STEPS",
    "",
    `Showing ${input.shown} of ${input.total} findings.`,
    `Full report: ${opaqueTemporaryReportPath(input.reportPath)}`,
    `Expires after ${input.expiresAfterRuns} more Zedbee ${runLabel}.`,
    "",
    ...outcomeInstructions(input.outcome),
    "The terminal output is abbreviated; do not treat it as the complete report.",
  ]);
}
