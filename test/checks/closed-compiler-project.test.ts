import { expect, it, vi } from "vitest";
import * as contained from "../../src/inspection/read-json.js";
import { isClosedCompilerProject } from "../../src/checks/closed-compiler-project.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../inspection/fixture.js";

it("enforces proof read budgets before allocating source or configuration", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", { name: "bounded" });
  await f.writeJson("tsconfig.json", {
    compilerOptions: { types: [] },
    include: ["src"],
  });
  await f.write(
    "src/value.ts",
    "export const value=1;" + " ".repeat(2 * 1024 * 1024),
  );
  const inspection = await inspectRepository(f.root);
  const read = vi.spyOn(contained, "readContainedFile");
  try {
    expect(
      await isClosedCompilerProject(inspection, inspection.workspaces[0]!),
    ).toBe(false);
    const reads = read.mock.calls.filter(
      ([, path]) => path === "tsconfig.json" || path === "src/value.ts",
    );
    expect(reads).toHaveLength(2);
    for (const [, , options] of reads)
      expect(options?.maxBytes).toBeLessThanOrEqual(1024 * 1024);
  } finally {
    read.mockRestore();
  }
});
