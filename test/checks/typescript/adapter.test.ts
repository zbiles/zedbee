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
