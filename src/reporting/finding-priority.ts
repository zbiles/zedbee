import type { Finding } from "../core/types.js";
import { compareCodeUnits } from "../core/compare.js";
import { compareFindings } from "../core/summarize.js";

// Deliberate code allowlists: arbitrary analyzer prose never establishes causality.
const ACTIONABLE_COMPILER_CODES = new Set([
  "TS1002",
  "TS1003",
  "TS1005",
  "TS1109",
  "TS1128",
  "TS1160", // syntax
  "TS2307",
  "TS2688",
  "TS2792",
  "TS6053",
  "TS6231", // unresolved inputs
  "TS5023",
  "TS5024",
  "TS5070",
  "TS5083",
  "TS5109",
  "TS5110", // configuration
]);
export function isUnresolvedModule(finding: Finding): boolean {
  return (
    finding.check === "types" &&
    ["typescript/TS2307", "typescript/TS2792"].includes(finding.rule)
  );
}
function priority(finding: Finding): number {
  if (finding.severity !== "error") return 4;
  if (
    finding.rule === "eslint/parsing-error" ||
    (finding.check === "types" &&
      ACTIONABLE_COMPILER_CODES.has(finding.rule.replace("typescript/", "")))
  )
    return 0;
  if (finding.check === "secrets" || finding.check === "structuralSecurity")
    return 1;
  if (
    finding.rule.startsWith("@typescript-eslint/no-unsafe-") ||
    [
      "typescript/TS7005",
      "typescript/TS7006",
      "typescript/TS7019",
      "typescript/TS7031",
    ].includes(finding.rule)
  )
    return 3;
  return 2;
}
/** Human presentation only; never use this order for canonical JSON or SARIF. */
export function comparePreviewFindings(left: Finding, right: Finding): number {
  return priority(left) - priority(right) || compareFindings(left, right);
}

export function omittedFindingLines(
  all: readonly Finding[],
  shown: readonly Finding[],
): readonly string[] {
  const selected = new Set(shown.map((finding) => finding.id));
  const groups = new Map<string, { finding: Finding; count: number }>();
  for (const finding of all) {
    if (selected.has(finding.id)) continue;
    const key = `${finding.severity}\0${finding.check}\0${finding.rule}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { finding, count: 1 });
  }
  return Object.freeze(
    [...groups.values()]
      .sort(
        (a, b) =>
          comparePreviewFindings(a.finding, b.finding) ||
          compareCodeUnits(a.finding.rule, b.finding.rule),
      )
      .map(
        ({ finding, count }) =>
          `${count} more ${finding.severity === "error" ? "blocking" : "warning"} finding${count === 1 ? "" : "s"}: ${finding.check} / ${finding.rule}.`,
      )
      .concat(
        groups.size === 0 ? [] : ["Complete details are in the full report."],
      ),
  );
}
