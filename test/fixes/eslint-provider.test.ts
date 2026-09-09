import { describe, expect, it } from "vitest";
import type { CheckRunContext, CheckTarget } from "../../src/checks/adapter.js";
import { observationCheckResult } from "../../src/checks/observation-result.js";
import { createLintAdapter } from "../../src/checks/eslint/lint-adapter.js";
import { createManagedEslint } from "../../src/checks/eslint/load-engine.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { ChangeSet, ChangedFile } from "../../src/git/change-set.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import { planManagedEslintFixes } from "../../src/fixes/eslint-provider.js";
import {
  createAnalysisReuseSession,
  withAnalysisReuseSession,
} from "../../src/checks/analysis-reuse.js";
import {
  captureAnalysisSources,
  withAnalysisSourceCapture,
} from "../../src/inspection/source-capture.js";

const target: CheckTarget = { id: ".", kind: "workspace", relativeRoot: "." };

function changeSet(files: readonly ChangedFile[]): ChangeSet {
  const changed = new Map(files.map((file) => [file.path, file]));
  return {
    files: changed,
    isEmpty: changed.size === 0,
    containsAddedLine(file, line) {
      return (
        changed
          .get(file)
          ?.addedRanges.some(
            (range) => line >= range.start && line <= range.end,
          ) ?? false
      );
    },
  };
}

describe("planManagedEslintFixes", () => {
  it.each([false, true, "sources"])(
    "plans only reported official lint fixes and never ESLint suggestions (session=%s)",
    async (reuse) => {
      const run = async () => {
        const [baseline, staged, live] = await Promise.all([
          createInspectionFixture(),
          createInspectionFixture(),
          createInspectionFixture(),
        ]);
        const cleanSource = "export const used = 1;\n";
        const fixableSource = "export const used = 1;;\nconst unused = 2;\n";
        const unreportedSource = "export const preexisting = 1;;\n";
        for (const fixture of [baseline, staged, live]) {
          await fixture.writeJson("package.json", {
            name: "fixture",
            private: true,
          });
          await fixture.write("src/value.js", cleanSource);
          await fixture.write("test/preexisting.js", unreportedSource);
        }
        await staged.write("src/value.js", fixableSource);

        const changes = changeSet([
          {
            path: "src/value.js",
            status: "modified",
            addedRanges: [{ start: 1, end: 2 }],
          },
        ]);
        const config = resolveConfig({
          schemaVersion: 1,
          profile: "recommended",
          checks: {
            lint: {
              rules: { "no-extra-semi": "error", "no-unused-vars": "error" },
            },
          },
          overrides: [
            {
              files: ["test/**"],
              checks: { lint: { rules: { "no-unused-vars": "off" } } },
            },
          ],
        });
        const context: CheckRunContext = {
          repositoryRoot: live.root,
          changeSet: changes,
          config,
          snapshots: {
            baselineDir: baseline.root,
            targetDir: staged.root,
            baselineRef: "HEAD",
            targetRef: "index",
            unsupportedEntries: [],
          },
          baselineInspection: await inspectRepository(baseline.root),
          targetInspection: await inspectRepository(staged.root),
          target,
          policy: config.checks.lint,
          policyForFile: testFilePolicyResolver(config, changes),
          signal: new AbortController().signal,
        };
        const check = async () => {
          const collected = await createLintAdapter().collect(context);
          const reported = await observationCheckResult(
            "lint",
            collected,
            context,
            true,
          );
          const officialFix = reported.findings.find(
            (finding) => finding.rule === "no-extra-semi",
          );
          const suggestionOnly = reported.findings.find(
            (finding) => finding.rule === "no-unused-vars",
          );
          expect(officialFix).toBeDefined();
          expect(suggestionOnly).toBeDefined();

          const candidates = await planManagedEslintFixes(
            {
              context,
              checkId: "lint",
              files: ["src/value.js", "test/preexisting.js"],
              createEngine: () =>
                createManagedEslint({
                  cwd: context.targetInspection.snapshotRoot,
                  mode: "lint",
                  managedIgnores: [],
                  ruleOverrides: {
                    "no-extra-semi": "error",
                    "no-unused-vars": "error",
                  },
                }),
            },
            [officialFix!, suggestionOnly!],
          );

          expect(candidates).toEqual([
            expect.objectContaining({
              kind: "exact-file",
              checkId: "lint",
              file: "src/value.js",
              baseSource: fixableSource,
              edits: [
                expect.objectContaining({
                  findingId: officialFix!.id,
                }),
              ],
            }),
          ]);
          expect(JSON.stringify(candidates)).not.toContain("suggestions");
          expect(JSON.stringify(candidates)).not.toContain("preexisting");
          expect(Object.isFrozen(candidates)).toBe(true);
          expect(Object.isFrozen(candidates[0])).toBe(true);
        };
        if (reuse !== "sources") return check();
        const capture = (await captureAnalysisSources(
          [baseline, staged].map((fixture) => ({
            snapshotRoot: fixture.root,
            paths: ["src/value.js", "test/preexisting.js"],
          })),
        ))!;
        // Findings and official edits must refer to the acquired version.
        await staged.write("src/value.js", cleanSource);
        try {
          await withAnalysisSourceCapture(capture, check);
        } finally {
          await capture.close();
        }
      };
      if (reuse !== true) return run();
      const owner = createAnalysisReuseSession();
      try {
        await withAnalysisReuseSession(owner, run);
      } finally {
        await owner.close();
      }
    },
  );
});
