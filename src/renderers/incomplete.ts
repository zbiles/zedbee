import type { IncompleteCheckPresentation } from "../reporting/incomplete-checks.js";
import { terminalCellWidth, wrapTerminalWords } from "./terminal-cells.js";

function fieldLines(label: string, value: string, width: number): string[] {
  const prefix = `  ${label}: `;
  const prefixWidth = terminalCellWidth(prefix);
  const continuation = " ".repeat(prefixWidth);
  return wrapTerminalWords(value, Math.max(1, width - prefixWidth)).map(
    (line, index) => `${index === 0 ? prefix : continuation}${line}`,
  );
}

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
      ...fields.flatMap(({ label, value }) => fieldLines(label, value, width)),
    ]),
  ];
}
