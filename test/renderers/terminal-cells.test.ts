import { expect, it } from "vitest";
import { wrapLabeledTerminalWords, terminalCellWidth } from "../../src/renderers/terminal-cells.js";
it("wraps a field at forty columns with a single label", () => {
  const lines = wrapLabeledTerminalWords("  Issue: ", "One two three four five six seven eight nine ten eleven twelve 界.", 40);
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.filter(line => line.includes("Issue:"))).toHaveLength(1);
  expect(lines.every(line => terminalCellWidth(line) <= 40)).toBe(true);
});
