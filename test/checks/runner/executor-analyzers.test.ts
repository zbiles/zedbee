import { expect, it } from "vitest";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";
import { serializeCheckContext } from "../../../src/checks/runner/context.js";
import { createLocalAnalyzerExecutor } from "../../../src/checks/runner/executor.js";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../../src/checks/prettier/settings.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("runs every real analyzer through reused supervised sessions", async () => {
  const fixture = await createInspectionFixture();
  await fixture.writeJson("package.json", {
    name: "executor-real",
    private: true,
    type: "module",
    dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
  });
  await fixture.write(
    "src/app.tsx",
    "export function App({ready}: {ready: boolean}) { if (ready) return <img />; return <main />; }\n",
  );
  await fixture.writeJson("tsconfig.json", {
    compilerOptions: {
      noEmit: true,
      strict: true,
      jsx: "react-jsx",
      types: [],
    },
    include: ["src"],
  });
  const inspection = await inspectRepository(fixture.root);
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "recommended",
    checks: {
      lint: { typeInformation: "basic" },
      cyclomaticComplexity: { max: 1 },
    },
  });
  const changeSet = {
    files: new Map([
      [
        "src/app.tsx",
        {
          path: "src/app.tsx",
          status: "modified" as const,
          addedRanges: [{ start: 1, end: 1 }],
        },
      ],
    ]),
    isEmpty: false,
    containsAddedLine: () => true,
  };
  const context: CheckRunContext = {
    repositoryRoot: fixture.root,
    snapshots: {
      baselineDir: fixture.root,
      targetDir: fixture.root,
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
    },
    baselineInspection: inspection,
    targetInspection: inspection,
    target: { id: ".", kind: "workspace", relativeRoot: "." },
    changeSet,
    config,
    policy: config.checks.lint,
    policyForFile: testFilePolicyResolver(config, changeSet),
    signal: new AbortController().signal,
  };
  const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
  try {
    for (let pass = 0; pass < 2; pass++) {
      const session = await executor.openSession();
      try {
        expect(
          await session.run({
            version: 1,
            checkId: "formatting",
            operation: "format-working-source",
            input: {
              file: "a.js",
              source: "const x=1",
              settings: DEFAULT_FORMATTING_SETTINGS,
            },
          }),
        ).toBe("const x = 1;\n");
        for (const checkId of [
          "lint",
          "types",
          "cyclomaticComplexity",
          "readabilityComplexity",
          "structuralSecurity",
          "secrets",
          "duplication",
          "dependencyArchitecture",
          "deadCode",
          "reactAccessibility",
          "vulnerabilities",
          "reactCorrectness",
        ] as const) {
          const result = await session.run({
            version: 1,
            checkId,
            operation: "collect",
            context: serializeCheckContext({
              ...context,
              policy: config.checks[checkId],
            }),
          });
          expect(result.checkId).toBe(checkId);
          expect(result.target).toEqual(context.target);
          if (checkId === "cyclomaticComplexity")
            expect(result.targetObservations[0]?.metric?.value).toBe(2);
          if (checkId === "reactAccessibility")
            expect(
              result.targetObservations.map((item) => item.rule),
            ).toContain("jsx-a11y/alt-text");
          if (checkId === "types")
            expect(result.targetObservations.length).toBeGreaterThan(0);
        }
      } finally {
        await session.close();
      }
    }
    const profiler = await executor.openSession();
    await profiler.run(
      {
        version: 1,
        checkId: "secrets",
        operation: "collect",
        context: serializeCheckContext({
          ...context,
          policy: config.checks.secrets,
        }),
      },
      {
        workerEntry: fileURLToPath(
          new URL("./fixtures/profiler-worker.mjs", import.meta.url),
        ),
      },
    );
    await profiler.close();
    expect(
      JSON.parse(
        await readFile(join(fixture.root, "profiler-state.json"), "utf8"),
      ),
    ).toEqual({ enabled: false, entries: [], measures: [] });
  } finally {
    await executor.close();
  }
}, 60_000);
