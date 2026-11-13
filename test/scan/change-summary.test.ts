import { expect, it } from "vitest";
import { summarizeChanges } from "../../src/scan/change-summary.js";
import { selectedChangesLine } from "../../src/reporting/source-identity.js";
import type { ChangedFile } from "../../src/git/change-set.js";
import { createReport } from "../helpers/scan-report.js";
import { renderJson } from "../../src/renderers/json.js";
it("counts renames once and uses the selected comparison's labels", () => {
  const counts = summarizeChanges({
    files: new Map(
      (["added", "modified", "deleted", "renamed"] as const).map((status) => [
        status,
        { path: status, status, addedRanges: [] } satisfies ChangedFile,
      ]),
    ),
    isEmpty: false,
    containsAddedLine: () => false,
  });
  expect(counts).toEqual({ added: 1, modified: 1, deleted: 1, renamed: 1 });
  const report = createReport({ changedFileCount: 4, changeSummary: counts });
  expect(selectedChangesLine(report)).toContain("Staged changes: 1 added");
  expect(selectedChangesLine({ ...report, mode: "base" })).toContain(
    "Committed changes:",
  );
  expect(JSON.parse(renderJson(report)).changeSummary).toEqual(counts);
  expect(
    selectedChangesLine({ ...report, mergeParents: ["a", "b"] }),
  ).toBeUndefined();
  expect(
    selectedChangesLine(createReport({ changedFileCount: null })),
  ).toBeUndefined();
  expect(JSON.parse(renderJson(createReport())).changeSummary).toBeUndefined();
});
