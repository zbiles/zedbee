import { describe, expect, it } from "vitest";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import { typescriptAdapter } from "../../src/checks/typescript/adapter.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";

describe("observation cache dependency inputs", () => {
  it("does not reuse TypeScript observations after an installed declaration changes", async () => {
    const [baseline, target, live, cacheRoot] = await Promise.all([
      createInspectionFixture(),
      createInspectionFixture(),
      createInspectionFixture(),
      createInspectionFixture(),
    ]);
    for (const fixture of [baseline, target, live]) {
      await fixture.writeJson("package.json", {
        name: "cache-dependency-inputs",
        private: true,
        type: "module",
        dependencies: { "fake-installed-dependency": "1.0.0" },
      });
      await fixture.writeJson("tsconfig.json", {
        compilerOptions: { strict: true },
        include: ["src/**/*.ts"],
      });
    }
    await baseline.write("src/value.ts", "export const value = 1;\n");
    await target.write(
      "src/value.ts",
      [
        'import { supplied } from "fake-installed-dependency";',
        "export const value: number = supplied;",
        "",
      ].join("\n"),
    );
    await live.writeJson(
      "node_modules/fake-installed-dependency/package.json",
      {
        name: "fake-installed-dependency",
        version: "1.0.0",
        type: "module",
        types: "index.d.ts",
      },
    );
    const writeDeclaration = (type: "number" | "string") =>
      live.write(
        "node_modules/fake-installed-dependency/index.d.ts",
        `export declare const supplied: ${type};\n`,
      );

    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
    });
    const changeSet: ChangeSet = {
      files: new Map([
        [
          "src/value.ts",
          {
            path: "src/value.ts",
            status: "modified",
            addedRanges: [{ start: 1, end: 2 }],
          },
        ],
      ]),
      isEmpty: false,
      containsAddedLine: (file, line) =>
        file === "src/value.ts" && line >= 1 && line <= 2,
    };
    const context = {
      repositoryRoot: live.root,
      changeSet,
      config,
      snapshots: {
        baselineDir: baseline.root,
        targetDir: target.root,
        baselineRef: "HEAD" as const,
        targetRef: "index" as const,
        unsupportedEntries: [],
      },
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(target.root),
      signal: new AbortController().signal,
      policyForFile: testFilePolicyResolver(config),
    };
    const cache = new ObservationCacheStore({ root: cacheRoot.root });
    const scan = async (useCache: boolean) =>
      evaluatePolicy(
        await dispatchChecks(
          [typescriptAdapter],
          context,
          useCache ? { cache } : {},
        ),
        config,
      );
    const semanticDecision = (decision: Awaited<ReturnType<typeof scan>>) => ({
      outcome: decision.outcome,
      results: decision.results.map((result) => ({
        checkId: result.checkId,
        status: result.status,
        target: result.target,
        findings: result.findings,
      })),
    });

    await writeDeclaration("number");
    const beforeDependencyChange = await scan(true);
    const freshBeforeDependencyChange = await scan(false);
    expect(beforeDependencyChange.outcome).toBe("pass");
    expect(semanticDecision(beforeDependencyChange)).toEqual(
      semanticDecision(freshBeforeDependencyChange),
    );

    await writeDeclaration("string");
    const afterChangedDependency = await scan(true);
    const freshAfterChangedDependency = await scan(false);
    expect(semanticDecision(afterChangedDependency)).toEqual(
      semanticDecision(freshAfterChangedDependency),
    );
    expect(afterChangedDependency.outcome).toBe("blocked");
    expect(
      afterChangedDependency.results
        .flatMap((result) => result.findings)
        .map((finding) => finding.rule),
    ).toContain("typescript/TS2322");

    await writeDeclaration("number");
    const afterRestoredDependency = await scan(true);
    const freshAfterRestoredDependency = await scan(false);
    expect(semanticDecision(afterRestoredDependency)).toEqual(
      semanticDecision(freshAfterRestoredDependency),
    );
    expect(afterRestoredDependency.outcome).toBe("pass");
  });
});
