import { expect, it, vi } from "vitest";
import { pairingSources } from "../../../../src/checks/eslint/project/adapter.js";
import { pairLocationObservations } from "../../../../src/attribution/pair-locations.js";
import type { Observation } from "../../../../src/core/types.js";
import type { ChangeSet } from "../../../../src/git/change-set.js";

const diagnostic = (file: string, line: number): Observation => ({
  check: "lint", rule: "no-undef", identity: file, severity: "error",
  message: "Unresolved name", location: {file, startLine: line, endLine: line},
});
it("reads only files needed to pair shifted existing diagnostics", async () => {
  const baseline = diagnostic("a.js", 1), target = diagnostic("a.js", 2);
  const input = {
    baselineDir: "baseline", targetDir: "target",
    baselineFiles: ["a.js", "deleted.js"], targetFiles: ["a.js", "other.js"],
    baselineObservations: [baseline, diagnostic("deleted.js", 1)],
    targetObservations: [target, target],
    changeSet: {files: new Map(), isEmpty: true, containsAddedLine: () => false} as ChangeSet,
  };
  const read = vi.fn(async (root: string, files: readonly string[]) =>
    Object.fromEntries(files.map(file => [file, root === "baseline" ? "use(x);\n" : "// moved\nuse(x);\n"])));
  const sources = await pairingSources(input, read);
  expect(read.mock.calls).toEqual([["baseline", ["a.js"]], ["target", ["a.js"]]]);
  const paired = pairLocationObservations({files: sources.baseline, observations: [baseline]}, {files: sources.target, observations: [target]}, input.changeSet);
  expect(paired.baselineObservations[0]!.comparisonIdentity).toBe(paired.targetObservations[0]!.comparisonIdentity);
  read.mockClear();
  expect(await pairingSources({...input, targetObservations: []}, read)).toEqual({baseline: {}, target: {}});
  expect(read).not.toHaveBeenCalled();
});
