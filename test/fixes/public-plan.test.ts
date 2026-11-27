import { expect, it } from "vitest";
import { renderPlanText } from "../../src/reporting/fix-presentation.js";
import { publicPlan, renderFixPlanJson } from "../../src/fixes/public-plan.js";
import type { FixPlanItem, WorkingFilePreview } from "../../src/fixes/types.js";

it("groups items once when projecting hundreds of file summaries", () => {
  let pathReads = 0;
  const files = new Map<string, WorkingFilePreview>();
  const items: FixPlanItem[] = [];
  for (let index = 0; index < 500; index++) {
    const path = `src/${index}.ts`;
    files.set(path, {
      path,
      content: "private source",
      sha256: "private digest",
      mode: 0o644,
      hasUnstagedChanges: false,
    });
    items.push({
      checkId: "lint",
      get file() {
        pathReads++;
        return path;
      },
      findingIds: [`finding-${index}`],
      scope: "finding",
      fixes: 1,
      blocking: 1,
      warnings: 0,
      status: "applicable",
    });
  }
  const plan = publicPlan(["lint"], items, files, []);
  expect(plan.summary).toEqual({
    fixes: 500,
    files: 500,
    blocking: 500,
    warnings: 0,
    skipped: 0,
  });
  expect(plan.files.every((file) => file.applicableFixes === 1)).toBe(true);
  expect(pathReads).toBeLessThanOrEqual(items.length * 3);
  expect(JSON.stringify(plan)).not.toContain("private source");
});

it("retains legacy per-finding and whole-file fix counts in text and JSON", () => {
  const source: WorkingFilePreview = {
    path: "one.ts",
    sha256: "abc",
    content: "",
    mode: 420,
    hasUnstagedChanges: false,
  };
  const base = {
    file: source.path,
    blocking: 0,
    warnings: 0,
    status: "applicable" as const,
  };
  const plan = publicPlan(
    ["lint", "formatting"],
    [
      { ...base, checkId: "lint", scope: "finding", findingIds: ["a", "b"] },
      {
        ...base,
        checkId: "formatting",
        scope: "working-file",
        findingIds: ["a", "b"],
      },
    ],
    new Map([[source.path, source]]),
    [],
  );
  expect(JSON.parse(renderFixPlanJson(plan)).summary.fixes).toBe(3);
  expect(renderPlanText(plan)).toContain("3 fixes across 1 file");
});
