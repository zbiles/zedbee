import { describe, expect, it } from "vitest";
import { presentFixResult } from "../../src/fixes/result-presentation.js";
import type { FixPlan, FixResult } from "../../src/fixes/types.js";

const plan: FixPlan = {
  schemaVersion: 1,
  target: "index",
  selectedChecks: ["formatting"],
  exitCode: 0,
  summary: { fixes: 2, files: 2, blocking: 2, warnings: 0, skipped: 0 },
  files: [],
  items: [],
};

describe("presentFixResult", () => {
  it("calls a mixed already-present and unresolved zero-write result partial", () => {
    const result: FixResult = {
      exitCode: 1,
      appliedFixes: 0,
      changedFiles: [],
      unchangedFiles: ["src/already.ts", "src/stale.ts"],
      issues: [
        {
          kind: "stale",
          file: "src/stale.ts",
          checkIds: ["formatting"],
          message: "The working file changed after preview.",
          remediation: "Build a fresh plan.",
        },
      ],
    };

    expect(presentFixResult(plan, result)).toMatchObject({
      outcome: "partially-applied",
      alreadyFixedFiles: ["src/already.ts"],
      unresolvedFiles: ["src/stale.ts"],
    });
  });
});
