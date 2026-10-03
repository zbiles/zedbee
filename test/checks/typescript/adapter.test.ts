import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import {
  analyzeTypescriptSnapshots,
  typescriptAdapter,
} from "../../../src/checks/typescript/adapter.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import {
  createInspectionFixture,
  type InspectionFixture,
} from "../../inspection/fixture.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

const target = { id: ".", kind: "workspace" as const, relativeRoot: "." };

async function fixtures(): Promise<{
  baseline: InspectionFixture;
  staged: InspectionFixture;
  live: InspectionFixture;
}> {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", { name: "fixture", private: true });
  }
  return { baseline, staged, live };
}

function changes(path = "src/value.ts", start = 1, end = start): ChangeSet {
  return {
    files: new Map([
      [
        path,
        { path, status: "modified" as const, addedRanges: [{ start, end }] },
      ],
    ]),
    isEmpty: false,
    containsAddedLine(file, line) {
      return file === path && line >= start && line <= end;
    },
  };
}

async function context(
  value: Awaited<ReturnType<typeof fixtures>>,
  changeSet = changes(),
): Promise<CheckRunContext> {
  const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
  return {
    repositoryRoot: value.live.root,
    changeSet,
    config,
    snapshots: {
      baselineDir: value.baseline.root,
      targetDir: value.staged.root,
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(value.baseline.root),
    targetInspection: await inspectRepository(value.staged.root),
    target,
    policy: config.checks.types,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

describe("TypeScript observation adapter", () => {
  it("reports the staged type error even when the live working-tree file is clean", async () => {
    const observations = await analyzeTypescriptSnapshots({
      baseline: { "src/value.ts": "export const value: number = 1;" },
      target: { "src/value.ts": 'export const value: number = "staged";' },
      live: { "src/value.ts": "export const value: number = 2;" },
    });

    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "typescript/TS2322",
          location: expect.objectContaining({ file: "src/value.ts" }),
        }),
      ]),
    );
  });

  it("suppresses baseline debt but reports a new target diagnostic", async () => {
    const observations = await analyzeTypescriptSnapshots({
      baseline: {
        "src/existing.ts": 'const existing: number = "debt";',
        "src/new.ts": "export const value = 1;",
      },
      target: {
        "src/existing.ts": 'const existing: number = "debt";',
        "src/new.ts": 'export const value: number = "new debt";',
      },
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      rule: "typescript/TS2322",
      location: {
        file: "src/new.ts",
        startLine: 1,
        startColumn: 14,
        endLine: 1,
        endColumn: 19,
      },
    });
  });

  it("reports a new project-level unresolved-module diagnostic", async () => {
    const observations = await analyzeTypescriptSnapshots({
      baseline: { "src/main.ts": "export {};" },
      target: {
        "src/main.ts":
          'import type { Missing } from "missing-zedbee-package"; export type Result = Missing;',
      },
    });

    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "typescript/TS2307" }),
      ]),
    );
  });

  it("collects from staged snapshots and leaves a clean live edit invisible", async () => {
    const value = await fixtures();
    for (const fixture of [value.baseline, value.staged, value.live]) {
      await fixture.write(
        "tsconfig.json",
        '{ "compilerOptions": { "strict": true }, // JSONC\n "include": ["src/**/*.ts"] }\n',
      );
    }
    await value.baseline.write(
      "src/value.ts",
      "export const value: number = 1;\n",
    );
    await value.staged.write(
      "src/value.ts",
      'export const value: number = "staged";\n',
    );
    await value.live.write("src/value.ts", "export const value: number = 2;\n");
    const run = await context(value);

    const applicability = await typescriptAdapter.inspect(run);
    expect(applicability).toMatchObject({
      applies: true,
      requiresBaseline: true,
    });
    const collected = await typescriptAdapter.collect(run);

    expect(collected.targetObservations).toContainEqual(
      expect.objectContaining({
        rule: "typescript/TS2322",
        location: expect.objectContaining({
          file: "src/value.ts",
          startLine: 1,
        }),
      }),
    );
  });

  it("expands a common directory-only tsconfig include", async () => {
    const value = await fixtures();
    for (const fixture of [value.baseline, value.staged]) {
      await fixture.writeJson("tsconfig.json", {
        compilerOptions: { strict: true, target: "ES2022" },
        include: ["src"],
      });
      await fixture.write(
        "src/value.ts",
        "export const value: string = 'ok';\n",
      );
    }
    await value.staged.write(
      "src/value.ts",
      "export const value: string = 42;\n",
    );
    const run = await context(value);

    await expect(typescriptAdapter.collect(run)).resolves.toMatchObject({
      targetObservations: [
        expect.objectContaining({ rule: "typescript/TS2322" }),
      ],
    });
  });

  it("keeps baseline debt unattributed and attributes only the changed-line error", async () => {
    const value = await fixtures();
    for (const fixture of [value.baseline, value.staged]) {
      await fixture.writeJson("tsconfig.json", {
        compilerOptions: { strict: true },
        include: ["src/**/*.ts"],
      });
    }
    await value.baseline.write(
      "src/value.ts",
      'const old: number = "debt";\nexport { old };\n',
    );
    await value.staged.write(
      "src/value.ts",
      'const old: number = "debt";\nconst added: number = "new";\nexport { old, added };\n',
    );
    const run = await context(value, changes("src/value.ts", 2));
    const collected = await typescriptAdapter.collect(run);
    const result = await observationCheckResult("types", collected, run, true);

    expect(
      result.findings.filter((finding) => finding.attribution.staged),
    ).toEqual([
      expect.objectContaining({
        rule: "typescript/TS2322",
        location: expect.objectContaining({ startLine: 2 }),
      }),
    ]);
  });

  it("attributes new errors on unchanged references after an exported declaration is renamed", async () => {
    const value = await fixtures();
    for (const fixture of [value.baseline, value.staged]) {
      await fixture.writeJson("tsconfig.json", {
        compilerOptions: { strict: true },
        include: ["src/**/*.ts", "src/**/*.tsx"],
      });
      await fixture.write(
        "src/summarize.ts",
        "export const advisoryLabel = () => 'label';\n\nexport const label = advisoryLabel();\n",
      );
      await fixture.write(
        "src/shape-evidence.tsx",
        "import { advisoryLabel } from './summarize';\nexport const evidence = advisoryLabel();\n",
      );
      await fixture.write(
        "src/summarize.test.ts",
        "import { advisoryLabel } from './summarize';\nexport const testLabel = advisoryLabel();\n",
      );
      await fixture.write(
        "src/existing.ts",
        'export const existing: number = "debt";\n',
      );
    }
    await value.staged.write(
      "src/summarize.ts",
      "export const advisoryLabelRenamed = () => 'label';\n\nexport const label = advisoryLabel();\n",
    );
    const run = await context(value, changes("src/summarize.ts", 1));
    const collected = await typescriptAdapter.collect(run);

    expect(collected.targetObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "typescript/TS2304" }),
        expect.objectContaining({ rule: "typescript/TS2305" }),
      ]),
    );
    const result = await observationCheckResult("types", collected, run, true);
    expect(
      result.findings
        .filter((finding) => finding.attribution.staged)
        .map((finding) => ({
          rule: finding.rule,
          file: finding.location?.file,
          line: finding.location?.startLine,
        })),
    ).toEqual([
      { rule: "typescript/TS2305", file: "src/shape-evidence.tsx", line: 1 },
      { rule: "typescript/TS2305", file: "src/summarize.test.ts", line: 1 },
      { rule: "typescript/TS2304", file: "src/summarize.ts", line: 3 },
    ]);
  });

  it("keeps baseline errors non-blocking when an unrelated insertion moves their lines", async () => {
    const value = await fixtures();
    for (const fixture of [value.baseline, value.staged]) {
      await fixture.writeJson("tsconfig.json", {
        compilerOptions: { strict: true },
        include: ["src/**/*.ts"],
      });
    }
    await value.baseline.write(
      "src/value.ts",
      'export const existing: number = "debt";\n',
    );
    await value.staged.write(
      "src/value.ts",
      'export const added = 1;\nexport const existing: number = "debt";\n',
    );
    const run = await context(value, changes("src/value.ts", 1));
    const collected = await typescriptAdapter.collect(run);
    const result = await observationCheckResult("types", collected, run, true);

    expect(
      result.findings.filter((finding) => finding.attribution.staged),
    ).toEqual([]);
  });

  it.each([
    {
      name: "adding a required function parameter",
      before: "export function advisoryLabel() { return 'label'; }\n",
      after:
        "export function advisoryLabel(required: string) { return required; }\n",
      caller:
        "import { advisoryLabel } from './summarize';\nexport const label = advisoryLabel();\n",
      rule: "typescript/TS2554",
      line: 2,
      addedLines: true,
    },
    {
      name: "adding a required type property",
      before: "export interface Advisory { label: string }\n",
      after: "export interface Advisory { label: string; rank: number }\n",
      caller:
        "import type { Advisory } from './summarize';\nexport const advisory: Advisory = { label: 'label' };\n",
      rule: "typescript/TS2741",
      line: 2,
      addedLines: true,
    },
    {
      name: "deleting an export without adding a line",
      before:
        "export const advisoryLabel = () => 'label';\nexport const remaining = 1;\n",
      after: "export const remaining = 1;\n",
      caller:
        "import { advisoryLabel } from './summarize';\nexport const label = advisoryLabel();\n",
      rule: "typescript/TS2305",
      line: 1,
      addedLines: false,
    },
    {
      name: "deleting the imported file",
      before: "export const advisoryLabel = () => 'label';\n",
      after: undefined,
      caller:
        "import { advisoryLabel } from './summarize';\nexport const label = advisoryLabel();\n",
      rule: "typescript/TS2307",
      line: 1,
      addedLines: false,
    },
  ])("reports errors in unchanged files after $name", async (scenario) => {
    const value = await fixtures();
    for (const fixture of [value.baseline, value.staged]) {
      await fixture.writeJson("tsconfig.json", {
        compilerOptions: { strict: true },
        include: ["src/**/*.ts", "src/**/*.tsx"],
      });
      await fixture.write("src/shape-evidence.tsx", scenario.caller);
      await fixture.write("src/summarize.test.ts", scenario.caller);
      await fixture.write(
        "src/existing.ts",
        'export const existing: number = "debt";\n',
      );
    }
    await value.baseline.write("src/summarize.ts", scenario.before);
    if (scenario.after !== undefined)
      await value.staged.write("src/summarize.ts", scenario.after);
    const changeSet: ChangeSet = {
      files: new Map([
        [
          "src/summarize.ts",
          {
            path: "src/summarize.ts",
            status: scenario.after === undefined ? "deleted" : "modified",
            addedRanges: scenario.addedLines ? [{ start: 1, end: 1 }] : [],
          },
        ],
      ]),
      isEmpty: false,
      containsAddedLine: (path, line) =>
        scenario.addedLines && path === "src/summarize.ts" && line === 1,
    };
    const run = await context(value, changeSet);
    expect(await typescriptAdapter.inspect(run)).toMatchObject({
      applies: true,
      targets: [target],
    });
    const collected = await typescriptAdapter.collect(run);
    const result = await observationCheckResult("types", collected, run, true);

    expect(
      result.findings
        .filter((finding) => finding.attribution.staged)
        .map((finding) => ({
          rule: finding.rule,
          file: finding.location?.file,
          line: finding.location?.startLine,
        })),
    ).toEqual([
      {
        rule: scenario.rule,
        file: "src/shape-evidence.tsx",
        line: scenario.line,
      },
      {
        rule: scenario.rule,
        file: "src/summarize.test.ts",
        line: scenario.line,
      },
    ]);
  });

  it("reports a changed diagnostic even when its TypeScript code and location match baseline debt", async () => {
    const value = await fixtures();
    for (const fixture of [value.baseline, value.staged]) {
      await fixture.writeJson("tsconfig.json", {
        compilerOptions: { strict: true },
        include: ["src/**/*.ts"],
      });
    }
    await value.baseline.write(
      "src/value.ts",
      'export const value: number = "debt";\n',
    );
    await value.staged.write(
      "src/value.ts",
      "export const value: number = false;\n",
    );
    const run = await context(value);
    const collected = await typescriptAdapter.collect(run);
    const result = await observationCheckResult("types", collected, run, true);

    expect(
      result.findings.filter((finding) => finding.attribution.staged),
    ).toEqual([
      expect.objectContaining({
        rule: "typescript/TS2322",
        message: "Type 'boolean' is not assignable to type 'number'.",
      }),
    ]);
  });

  it.each([
    {
      name: "a trailing comment",
      before: 'export const existing: number = "debt";\n',
      after: 'export const existing: number = "debt"; // comment\n',
    },
    {
      name: "a final newline",
      before: 'export const existing: number = "debt";',
      after: 'export const existing: number = "debt";\n',
    },
  ])(
    "keeps existing diagnostics non-blocking after adding $name",
    async ({ before, after }) => {
      const value = await fixtures();
      for (const fixture of [value.baseline, value.staged]) {
        await fixture.writeJson("tsconfig.json", {
          compilerOptions: { strict: true },
          include: ["src/**/*.ts"],
        });
      }
      await value.baseline.write("src/value.ts", before);
      await value.staged.write("src/value.ts", after);
      const run = await context(value);
      const result = await observationCheckResult(
        "types",
        await typescriptAdapter.collect(run),
        run,
        true,
      );

      expect(
        result.findings.filter((finding) => finding.attribution.staged),
      ).toEqual([]);
    },
  );

  it("keeps existing diagnostics non-blocking after a pure file rename", async () => {
    const value = await fixtures();
    for (const fixture of [value.baseline, value.staged]) {
      await fixture.writeJson("tsconfig.json", {
        compilerOptions: { strict: true },
        include: ["src/**/*.ts"],
      });
    }
    await value.baseline.write(
      "src/old.ts",
      'export const existing: number = "debt";\n',
    );
    await value.staged.write(
      "src/new.ts",
      'export const existing: number = "debt";\n',
    );
    const changeSet: ChangeSet = {
      files: new Map([
        [
          "src/new.ts",
          {
            path: "src/new.ts",
            previousPath: "src/old.ts",
            status: "renamed",
            addedRanges: [],
          },
        ],
      ]),
      isEmpty: false,
      containsAddedLine: () => false,
    };
    const run = await context(value, changeSet);
    const result = await observationCheckResult(
      "types",
      await typescriptAdapter.collect(run),
      run,
      true,
    );

    expect(
      result.findings.filter((finding) => finding.attribution.staged),
    ).toEqual([]);
  });

  it("reads local extends and project references as inert snapshot JSON and never emits", async () => {
    const value = await fixtures();
    for (const fixture of [value.baseline, value.staged]) {
      await fixture.writeJson("config/base.json", {
        compilerOptions: { strict: true, outDir: "../dist" },
      });
      await fixture.writeJson("packages/shared/tsconfig.json", {
        compilerOptions: { composite: true },
        files: [],
      });
      await fixture.write(
        "tsconfig.json",
        [
          "{",
          "  // loaders are never executed",
          '  "extends": "./config/base.json",',
          '  "references": [{ "path": "./packages/shared" }],',
          '  "include": ["src/**/*.ts"]',
          "}",
          "",
        ].join("\n"),
      );
      await fixture.write("src/value.ts", "export const value: number = 1;\n");
    }
    const run = await context(value);

    await expect(typescriptAdapter.collect(run)).resolves.toMatchObject({
      checkId: "types",
      targetObservations: [],
    });
    await expect(
      access(join(value.staged.root, "dist", "value.js")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(value.staged.root, "tsconfig.tsbuildinfo")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("analyzes referenced project source instead of merely validating its config", async () => {
    const value = await fixtures();
    for (const fixture of [value.baseline, value.staged]) {
      await fixture.writeJson("tsconfig.json", {
        compilerOptions: { strict: true },
        references: [{ path: "./packages/shared" }],
        include: ["src/**/*.ts"],
      });
      await fixture.writeJson("packages/shared/tsconfig.json", {
        compilerOptions: { composite: true, strict: true },
        include: ["src/**/*.ts"],
      });
      await fixture.write("src/main.ts", "export {};\n");
      await fixture.write(
        "packages/shared/src/value.ts",
        "export const value: number = 1;\n",
      );
    }
    await value.staged.write(
      "packages/shared/src/value.ts",
      'export const value: number = "staged";\n',
    );
    const run = await context(
      value,
      changes("packages/shared/src/value.ts", 1),
    );

    const collected = await typescriptAdapter.collect(run);

    expect(collected.targetObservations).toContainEqual(
      expect.objectContaining({
        rule: "typescript/TS2322",
        location: expect.objectContaining({
          file: "packages/shared/src/value.ts",
          startLine: 1,
        }),
      }),
    );
  });
});
