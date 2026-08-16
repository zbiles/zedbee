import { describe, expect, it } from "vitest";
import type {
  CheckRunContext,
  CheckTarget,
} from "../../../src/checks/adapter.js";
import { dependencyArchitectureAdapter } from "../../../src/checks/dependency-architecture/adapter.js";
import { DEPENDENCY_RULE_NAMES } from "../../../src/checks/dependency-architecture/rules.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";

const target: CheckTarget = { id: ".", kind: "workspace", relativeRoot: "." };

function changes(...paths: string[]): ChangeSet {
  const files = new Map(
    paths.map((path) => [
      path,
      {
        path,
        status: "modified" as const,
        addedRanges: [{ start: 1, end: 3 }],
      },
    ]),
  );
  return {
    files,
    isEmpty: false,
    containsAddedLine(file, line) {
      return files.has(file) && line >= 1 && line <= 3;
    },
  };
}

async function cycleContext(): Promise<CheckRunContext> {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", { name: "fixture", private: true });
    await fixture.writeJson("tsconfig.json", {
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src"],
    });
    await fixture.write(
      "src/a.ts",
      "import { b } from './b.js'; export const a = b;\n",
    );
    await fixture.write(
      "src/b.ts",
      "import { a } from './a.js'; export const b = a;\n",
    );
    await fixture.write(
      "src/d.ts",
      "import { c } from './c.js'; export const d = c;\n",
    );
  }
  await baseline.write("src/c.ts", "export const c = 1;\n");
  await staged.write(
    "src/c.ts",
    "import { d } from './d.js'; export const c = d;\n",
  );
  await live.write("src/c.ts", "export const c = 'live';\n");
  const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
  return {
    repositoryRoot: live.root,
    changeSet: changes("src/c.ts"),
    config,
    snapshots: {
      baselineDir: baseline.root,
      targetDir: staged.root,
      baselineRef: "HEAD",
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(baseline.root),
    targetInspection: await inspectRepository(staged.root),
    target,
    policy: config.checks.dependencyArchitecture,
    signal: new AbortController().signal,
  };
}

async function edgeContext(
  targetSource: string,
  extra: (
    fixture: Awaited<ReturnType<typeof createInspectionFixture>>,
  ) => Promise<void>,
  dependencies: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  } = { devDependencies: { vitest: "4.1.10" } },
  sourcePath = "src/changed.ts",
): Promise<CheckRunContext> {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", {
      name: "fixture",
      private: true,
      ...dependencies,
    });
    await extra(fixture);
  }
  await baseline.write(sourcePath, "export const changed = 1;\n");
  await staged.write(sourcePath, targetSource);
  await live.write(sourcePath, "export const changed = 'live';\n");
  const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
  return {
    repositoryRoot: live.root,
    changeSet: changes(sourcePath),
    config,
    snapshots: {
      baselineDir: baseline.root,
      targetDir: staged.root,
      baselineRef: "HEAD",
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(baseline.root),
    targetInspection: await inspectRepository(staged.root),
    target,
    policy: config.checks.dependencyArchitecture,
    signal: new AbortController().signal,
  };
}

async function stagedFindings(context: CheckRunContext) {
  const set = await dependencyArchitectureAdapter.collect(context);
  const result = await observationCheckResult(
    "dependencyArchitecture",
    set,
    context,
    true,
  );
  return result.findings.filter(({ attribution }) => attribution.staged);
}

describe("dependencyArchitectureAdapter", () => {
  it("keeps an existing cycle as debt and attributes only a newly closed cycle", async () => {
    const context = await cycleContext();
    await expect(
      dependencyArchitectureAdapter.inspect(context),
    ).resolves.toMatchObject({
      applies: true,
      executionClass: "project-analysis",
      requiresBaseline: true,
      targets: [target],
    });

    const findings = await stagedFindings(context);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: DEPENDENCY_RULE_NAMES.circular,
        location: { file: "src/c.ts" },
        attribution: expect.objectContaining({
          kind: "baseline-comparison",
          staged: true,
        }),
      }),
    ]);
    expect(JSON.stringify(findings)).not.toContain("live");
  });

  it("attributes an unresolved changed import", async () => {
    const context = await edgeContext(
      "import missing from './missing.js'; export const changed = missing;\n",
      async () => undefined,
    );
    expect(await stagedFindings(context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: DEPENDENCY_RULE_NAMES.unresolved,
          location: { file: "src/changed.ts" },
        }),
      ]),
    );
  });

  it("attributes a new production-to-test edge", async () => {
    const context = await edgeContext(
      "import { helper } from '../test/helper.js'; export const changed = helper;\n",
      (fixture) =>
        fixture.write("test/helper.ts", "export const helper = 1;\n"),
    );
    expect(await stagedFindings(context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: DEPENDENCY_RULE_NAMES.sourceToTest }),
      ]),
    );
  });

  it("attributes a production import declared only as a dev dependency", async () => {
    const context = await edgeContext(
      "import { describe } from 'vitest'; export const changed = describe;\n",
      async () => undefined,
    );
    expect(await stagedFindings(context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: DEPENDENCY_RULE_NAMES.productionToDev,
        }),
      ]),
    );
  });

  it("attributes an imported package missing from the manifest", async () => {
    const context = await edgeContext(
      "import leftPad from 'left-pad'; export const changed = leftPad;\n",
      async () => undefined,
      {},
    );
    expect(await stagedFindings(context)).toEqual([
      expect.objectContaining({
        rule: DEPENDENCY_RULE_NAMES.missingDependency,
        location: { file: "src/changed.ts" },
      }),
    ]);
  });

  it("does not report an installed-package resolution failure for a declared production dependency", async () => {
    const context = await edgeContext(
      "import leftPad from 'left-pad'; export const changed = leftPad;\n",
      async () => undefined,
      { dependencies: { "left-pad": "1.3.0" } },
    );
    expect(await stagedFindings(context)).toEqual([]);
  });

  it("does not classify Node built-ins or TypeScript path aliases as packages", async () => {
    const builtIn = await edgeContext(
      "import { readFile } from 'node:fs/promises'; export const changed = readFile;\n",
      async () => undefined,
    );
    expect(await stagedFindings(builtIn)).toEqual([]);

    const alias = await edgeContext(
      "import { helper } from 'utils/helper'; export const changed = helper;\n",
      async (fixture) => {
        await fixture.writeJson("tsconfig.json", {
          compilerOptions: {
            baseUrl: ".",
            paths: { "utils/*": ["src/utils/*"] },
          },
          include: ["src"],
        });
        await fixture.write(
          "src/utils/helper.ts",
          "export const helper = 1;\n",
        );
      },
    );
    expect(await stagedFindings(alias)).toEqual([]);
  });

  it("does not treat a test colocated under src as production code", async () => {
    const context = await edgeContext(
      "import { helper } from '../test/helper.js'; export const changed = helper;\n",
      (fixture) =>
        fixture.write("test/helper.ts", "export const helper = 1;\n"),
      {},
      "src/component.test.ts",
    );
    expect(await stagedFindings(context)).toEqual([]);
  });

  it("fails closed before Dependency Cruiser can follow an escaping import", async () => {
    const context = await edgeContext(
      "import value from '../../outside.js'; export const changed = value;\n",
      async () => undefined,
    );
    await expect(
      dependencyArchitectureAdapter.collect(context),
    ).rejects.toThrow("Dependency architecture analysis failed.");
  });

  it("fails closed on a TypeScript config that extends outside the snapshot", async () => {
    const context = await edgeContext(
      "export const changed = 1;\n",
      (fixture) =>
        fixture.writeJson("tsconfig.json", { extends: "../outside.json" }),
    );
    await expect(
      dependencyArchitectureAdapter.collect(context),
    ).rejects.toThrow("Dependency architecture analysis failed.");
  });

  it("schedules a workspace when a source is deleted", async () => {
    const [baseline, staged, live] = await Promise.all([
      createInspectionFixture(),
      createInspectionFixture(),
      createInspectionFixture(),
    ]);
    for (const fixture of [baseline, staged, live]) {
      await fixture.writeJson("package.json", { name: "fixture" });
      await fixture.write(
        "src/consumer.ts",
        "import { removed } from './removed.js'; export const value = removed;\n",
      );
    }
    await baseline.write("src/removed.ts", "export const removed = 1;\n");
    await live.write("src/removed.ts", "export const removed = 1;\n");
    const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
    const deletedFiles = new Map([
      [
        "src/removed.ts",
        {
          path: "src/removed.ts",
          status: "deleted" as const,
          addedRanges: [],
        },
      ],
    ]);
    const context: CheckRunContext = {
      repositoryRoot: live.root,
      changeSet: {
        files: deletedFiles,
        isEmpty: false,
        containsAddedLine: () => false,
      },
      config,
      snapshots: {
        baselineDir: baseline.root,
        targetDir: staged.root,
        baselineRef: "HEAD",
        unsupportedEntries: [],
      },
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(staged.root),
      target,
      policy: config.checks.dependencyArchitecture,
      signal: new AbortController().signal,
    };
    await expect(
      dependencyArchitectureAdapter.inspect(context),
    ).resolves.toMatchObject({
      applies: true,
      targets: [target],
    });
    expect(await stagedFindings(context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: DEPENDENCY_RULE_NAMES.unresolved }),
      ]),
    );
  });

  it("attributes a graph regression caused only by a manifest change", async () => {
    const [baseline, staged, live] = await Promise.all([
      createInspectionFixture(),
      createInspectionFixture(),
      createInspectionFixture(),
    ]);
    await baseline.writeJson("package.json", {
      dependencies: { "left-pad": "1.3.0" },
    });
    await staged.writeJson("package.json", {
      devDependencies: { "left-pad": "1.3.0" },
    });
    await live.writeJson("package.json", {
      dependencies: { "left-pad": "9.9.9-live" },
    });
    for (const fixture of [baseline, staged, live]) {
      await fixture.write(
        "src/changed.ts",
        "import leftPad from 'left-pad'; export const value = leftPad;\n",
      );
    }
    const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
    const context: CheckRunContext = {
      repositoryRoot: live.root,
      changeSet: changes("package.json"),
      config,
      snapshots: {
        baselineDir: baseline.root,
        targetDir: staged.root,
        baselineRef: "HEAD",
        unsupportedEntries: [],
      },
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(staged.root),
      target,
      policy: config.checks.dependencyArchitecture,
      signal: new AbortController().signal,
    };
    await expect(
      dependencyArchitectureAdapter.inspect(context),
    ).resolves.toMatchObject({
      applies: true,
      targets: [target],
    });
    expect(await stagedFindings(context)).toEqual([
      expect.objectContaining({
        rule: DEPENDENCY_RULE_NAMES.productionToDev,
        attribution: expect.objectContaining({
          staged: true,
          evidence: expect.arrayContaining(["project-delta"]),
        }),
      }),
    ]);
  });

  it("resolves declared workspace packages to their staged source entrypoints", async () => {
    const [baseline, staged, live] = await Promise.all([
      createInspectionFixture(),
      createInspectionFixture(),
      createInspectionFixture(),
    ]);
    for (const fixture of [baseline, staged, live]) {
      await fixture.writeJson("package.json", {
        private: true,
        workspaces: ["apps/*", "packages/*"],
      });
      await fixture.writeJson("apps/web/package.json", {
        name: "@repo/web",
        exports: "./src/main.ts",
        dependencies: { "@repo/shared": "workspace:*" },
      });
      await fixture.writeJson("packages/shared/package.json", {
        name: "@repo/shared",
        exports: {
          ".": "./src/main.ts",
          "./feature": "./src/feature.ts",
        },
        dependencies: { "@repo/web": "workspace:*" },
      });
      await fixture.write(
        "apps/web/src/main.ts",
        "import { feature } from '@repo/shared/feature'; export const web = feature;\n",
      );
      await fixture.write("apps/web/src/extra.ts", "export const extra = 1;\n");
      await fixture.write(
        "packages/shared/src/main.ts",
        "export { feature } from './feature.js';\n",
      );
    }
    await baseline.write(
      "packages/shared/src/feature.ts",
      "export const feature = 1;\n",
    );
    await staged.write(
      "packages/shared/src/feature.ts",
      "import { web } from '@repo/web'; export const feature = web;\n",
    );
    await live.write(
      "packages/shared/src/feature.ts",
      "export const feature = 'live';\n",
    );
    const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
    const workspaceTarget: CheckTarget = {
      id: "packages/shared",
      kind: "workspace",
      relativeRoot: "packages/shared",
    };
    const context: CheckRunContext = {
      repositoryRoot: live.root,
      changeSet: changes("packages/shared/src/feature.ts"),
      config,
      snapshots: {
        baselineDir: baseline.root,
        targetDir: staged.root,
        baselineRef: "HEAD",
        unsupportedEntries: [],
      },
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(staged.root),
      target: workspaceTarget,
      policy: config.checks.dependencyArchitecture,
      signal: new AbortController().signal,
    };
    const set = await dependencyArchitectureAdapter.collect(context);
    expect(set.targetObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: DEPENDENCY_RULE_NAMES.circular }),
      ]),
    );
    const result = await observationCheckResult(
      "dependencyArchitecture",
      set,
      context,
      true,
    );
    expect(
      result.findings.filter(({ attribution }) => attribution.staged),
    ).toEqual([
      expect.objectContaining({
        rule: DEPENDENCY_RULE_NAMES.circular,
        location: { file: "packages/shared/src/feature.ts" },
      }),
    ]);
  });

  it("still requires resolved workspace imports to be declared", async () => {
    const [baseline, staged, live] = await Promise.all([
      createInspectionFixture(),
      createInspectionFixture(),
      createInspectionFixture(),
    ]);
    for (const fixture of [baseline, staged, live]) {
      await fixture.writeJson("package.json", {
        private: true,
        workspaces: ["apps/*", "packages/*"],
      });
      await fixture.writeJson("apps/web/package.json", { name: "@repo/web" });
      await fixture.writeJson("apps/web/tsconfig.json", {
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@repo/shared": ["../../packages/shared/src/main.ts"],
          },
        },
        include: ["src"],
      });
      await fixture.writeJson("packages/shared/package.json", {
        name: "@repo/shared",
        exports: "./src/main.ts",
      });
      await fixture.write(
        "packages/shared/src/main.ts",
        "export const shared = 1;\n",
      );
    }
    await baseline.write("apps/web/src/main.ts", "export const web = 1;\n");
    await staged.write(
      "apps/web/src/main.ts",
      "import { shared } from '@repo/shared'; export const web = shared;\n",
    );
    await live.write("apps/web/src/main.ts", "export const web = 'live';\n");
    const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
    const workspaceTarget: CheckTarget = {
      id: "apps/web",
      kind: "workspace",
      relativeRoot: "apps/web",
    };
    const context: CheckRunContext = {
      repositoryRoot: live.root,
      changeSet: changes("apps/web/src/main.ts"),
      config,
      snapshots: {
        baselineDir: baseline.root,
        targetDir: staged.root,
        baselineRef: "HEAD",
        unsupportedEntries: [],
      },
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(staged.root),
      target: workspaceTarget,
      policy: config.checks.dependencyArchitecture,
      signal: new AbortController().signal,
    };
    const set = await dependencyArchitectureAdapter.collect(context);
    const result = await observationCheckResult(
      "dependencyArchitecture",
      set,
      context,
      true,
    );
    expect(
      result.findings.filter(({ attribution }) => attribution.staged),
    ).toEqual([
      expect.objectContaining({
        rule: DEPENDENCY_RULE_NAMES.missingDependency,
        location: { file: "apps/web/src/main.ts" },
      }),
    ]);
  });

  it("fails closed before running when cancelled", async () => {
    const context = await cycleContext();
    const controller = new AbortController();
    controller.abort();
    await expect(
      dependencyArchitectureAdapter.collect({
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Dependency architecture analysis failed.");
  });
});
