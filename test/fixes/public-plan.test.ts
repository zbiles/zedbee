import { expect, it } from "vitest";
import { publicPlan } from "../../src/fixes/public-plan.js";
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
