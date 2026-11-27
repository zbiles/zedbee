import type { IncompleteCheckPresentation } from "../reporting/incomplete-checks.js";
import {
  wrapLabeledTerminalWords,
  wrapTerminalWords,
} from "./terminal-cells.js";

export function incompleteSectionLines(
  incomplete: readonly IncompleteCheckPresentation[],
  width: number,
): string[] {
  if (incomplete.length === 0) return [];
  return [
    "",
    "INCOMPLETE CHECKS",
    ...incomplete.flatMap(({ title, fields }, index) => [
      ...(index === 0 ? [] : [""]),
      ...wrapTerminalWords(title, width),
      ...fields.flatMap(({ label, value }) =>
        wrapLabeledTerminalWords(`  ${label}: `, value, width),
      ),
    ]),
  ];
}
