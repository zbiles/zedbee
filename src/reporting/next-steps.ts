import type { ScanReport } from "../scan/report.js";
import type { ManagedAutomaticFix } from "../core/types.js";
import { compareCodeUnits } from "../core/compare.js";
import { formatTemporaryReportMaxAge } from "./report-age.js";
import { opaqueTemporaryReportPath } from "./report-path.js";

export interface NextStepsInput {
  readonly outcome: ScanReport["outcome"];
  readonly shown: number;
  readonly total: number;
  readonly reportPath: string;
  readonly maximumAge: string;
  readonly automaticFixes?: readonly ManagedAutomaticFix[];
}

export function managedFixGuidanceLines(
  automaticFixes: readonly ManagedAutomaticFix[],
): readonly string[] {
  const commands = [
    ...new Set(
      automaticFixes.map((automaticFix) => automaticFix.command.join(" ")),
    ),
  ].sort(compareCodeUnits);
  return Object.freeze(
    commands.length === 0
      ? []
      : [
          "Managed fix commands write the working tree; they do not stage changes.",
          ...commands,
        ],
  );
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
  const age = formatTemporaryReportMaxAge(input.maximumAge);
  const managedFixes = managedFixGuidanceLines(input.automaticFixes ?? []);
  return Object.freeze([
    "NEXT STEPS",
    "",
    `Showing ${input.shown} of ${input.total} findings.`,
    `Full report: ${opaqueTemporaryReportPath(input.reportPath)}`,
    `Zedbee will remove this report on the first run after ${age}.`,
    "The operating system may remove it sooner.",
    "",
    ...outcomeInstructions(input.outcome),
    ...managedFixes,
    "The terminal output is abbreviated; do not treat it as the complete report.",
  ]);
}
