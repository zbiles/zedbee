import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CheckRunContext,
  CheckTarget,
} from "../../../src/checks/adapter.js";
import { duplicationAdapter } from "../../../src/checks/duplication/adapter.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

const execaHarness = vi.hoisted(() => ({
  run: undefined as
    | undefined
    | ((
        file: string,
        args: readonly string[],
        options: Record<string, unknown>,
      ) => Promise<{ exitCode: number }>),
}));

vi.mock("execa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("execa")>();
  return {
    ...actual,
    execa(
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) {
      return execaHarness.run === undefined
        ? actual.execa(file, args, options)
        : execaHarness.run(file, args, options);
    },
  };
});

const target: CheckTarget = { id: ".", kind: "workspace", relativeRoot: "." };

function cloneBody(kind: "debt" | "new"): string {
  const lines =
    kind === "debt"
      ? Array.from(
          { length: 14 },
          (_, index) => `  if (value > ${index}) total = total + ${index + 1};`,
        )
      : Array.from(
          { length: 14 },
          (_, index) => `  result.item${index} = value + ${index};`,
        );
  return [
    "  let total = 0;",
    "  const result = {};",
    ...lines,
    "  return result;",
  ].join("\n");
}

function source(name: string, kind: "debt" | "new"): string {
  return `export function ${name}(value: number) {\n${cloneBody(kind)}\n}\n`;
}

function assignmentSource(name: string, count: number): string {
  const lines = Array.from(
    { length: count },
    (_, index) => `  result.item${index} = value + ${index};`,
  );
  return `export function ${name}(value: number) {\n  const result = {};\n${lines.join("\n")}\n  return result;\n}\n`;
}

function changes(path: string, end: number, start = 1): ChangeSet {
  return {
    files: new Map([
      [
        path,
        {
          path,
          status: "modified",
          addedRanges: [{ start, end }],
        },
      ],
    ]),
    isEmpty: false,
    containsAddedLine(file, line) {
      return file === path && line >= start && line <= end;
    },
  };
}

async function duplicationContext(
  targetChanged = true,
  paths = { template: "src/template.ts", changed: "src/changed.ts" },
): Promise<CheckRunContext> {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", { name: "fixture", private: true });
    await fixture.write("src/debt-a.ts", source("debtA", "debt"));
    await fixture.write("src/debt-b.ts", source("debtB", "debt"));
    await fixture.write(paths.template, source("template", "new"));
  }
  await baseline.write(
    paths.changed,
    "export function changed() { return 'baseline'; }\n",
  );
  await staged.write(
    paths.changed,
    targetChanged
      ? source("changed", "new")
      : "export function changed() { return 'target'; }\n",
  );
  await live.write(
    paths.changed,
    "export function changed() { return 'live'; }\n",
  );
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "thorough",
    checks: { duplication: { severity: "error", threshold: 0 } },
  });
  return {
    repositoryRoot: live.root,
    changeSet: changes(paths.changed, targetChanged ? 20 : 1),
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
    policy: config.checks.duplication,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

async function enlargementContext(): Promise<CheckRunContext> {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", { name: "fixture", private: true });
    await fixture.write("src/b.ts", assignmentSource("second", 14));
  }
  await baseline.write("src/a.ts", assignmentSource("first", 12));
  await staged.write("src/a.ts", assignmentSource("first", 14));
  await live.write("src/a.ts", assignmentSource("first", 1));
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "thorough",
    checks: { duplication: { severity: "error", threshold: 0 } },
  });
  return {
    repositoryRoot: live.root,
    changeSet: changes("src/a.ts", 17, 16),
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
    policy: config.checks.duplication,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

async function selfDuplicationContext(): Promise<CheckRunContext> {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", { name: "fixture", private: true });
  }
  const first = assignmentSource("first", 14);
  await baseline.write("src/only.ts", first);
  await staged.write(
    "src/only.ts",
    `${first}\n${assignmentSource("second", 14)}`,
  );
  await live.write("src/only.ts", "export const live = true;\n");
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "thorough",
    checks: { duplication: { severity: "error", threshold: 0 } },
  });
  return {
    repositoryRoot: live.root,
    changeSet: changes("src/only.ts", 40, 19),
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
    policy: config.checks.duplication,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

async function nestedWorkspaceContext(): Promise<CheckRunContext> {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    });
    await fixture.writeJson("packages/app/package.json", {
      name: "app",
      private: true,
    });
    await fixture.write("packages/app/src/a.ts", assignmentSource("a", 14));
    await fixture.write("packages/app/src/b.ts", assignmentSource("b", 14));
  }
  await baseline.write("src/root.ts", "export const root = 1;\n");
  await staged.write("src/root.ts", "export const root = 2;\n");
  await live.write("src/root.ts", "export const root = 3;\n");
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "thorough",
    checks: { duplication: { severity: "error", threshold: 0 } },
  });
  return {
    repositoryRoot: live.root,
    changeSet: changes("src/root.ts", 1),
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
    policy: config.checks.duplication,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

describe("duplication policy", () => {
  it("provides the documented percentage threshold without treating clone tokens as a percent", () => {
    const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });

    expect(config.checks.duplication).toEqual({
      severity: "error",
      when: "relevant",
      threshold: 5,
      settings: { minLines: 5, minTokens: 50, mode: "mild" },
    });
  });

  it("attributes only clone fragments introduced by staged source", async () => {
    const context = await duplicationContext();

    await expect(duplicationAdapter.inspect(context)).resolves.toMatchObject({
      applies: true,
      executionClass: "project-analysis",
      requiresBaseline: true,
      targets: [target],
    });
    const set = await duplicationAdapter.collect(context);
    const result = await observationCheckResult(
      "duplication",
      set,
      context,
      true,
    );
    const staged = result.findings.filter(
      ({ attribution }) => attribution.staged,
    );

    expect(staged.length).toBeGreaterThan(0);
    expect(staged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({ file: "src/changed.ts" }),
          attribution: expect.objectContaining({ kind: "range-overlap" }),
        }),
      ]),
    );
    expect(
      staged.every(({ location }) => location?.file === "src/changed.ts"),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("live");
  });

  it("does not attribute existing clones when only unrelated source changes", async () => {
    const context = await duplicationContext(false);
    const set = await duplicationAdapter.collect(context);
    const result = await observationCheckResult(
      "duplication",
      set,
      context,
      true,
    );

    expect(
      result.findings.filter(({ attribution }) => attribution.staged),
    ).toEqual([]);
  });

  it("attributes clones to their source paths when separate directories share a basename", async () => {
    const context = await duplicationContext(true, {
      template: "src/template/index.ts",
      changed: "src/changed/index.ts",
    });
    const set = await duplicationAdapter.collect(context);
    const result = await observationCheckResult(
      "duplication",
      set,
      context,
      true,
    );

    expect(set.targetObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({ file: "src/template/index.ts" }),
        }),
        expect.objectContaining({
          location: expect.objectContaining({ file: "src/changed/index.ts" }),
        }),
      ]),
    );
    expect(
      result.findings.filter(({ attribution }) => attribution.staged),
    ).toEqual([
      expect.objectContaining({
        location: expect.objectContaining({ file: "src/changed/index.ts" }),
        attribution: expect.objectContaining({ kind: "range-overlap" }),
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(context.snapshots.targetDir);
  });

  it("attributes an enlarged clone only to its changed fragment", async () => {
    const context = await enlargementContext();
    const set = await duplicationAdapter.collect(context);
    const result = await observationCheckResult(
      "duplication",
      set,
      context,
      true,
    );
    const staged = result.findings.filter(
      ({ attribution }) => attribution.staged,
    );

    expect(staged.length).toBeGreaterThan(0);
    expect(staged.every(({ location }) => location?.file === "src/a.ts")).toBe(
      true,
    );
    expect(staged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribution: expect.objectContaining({ kind: "range-overlap" }),
        }),
      ]),
    );
  });

  it("detects staged self-duplication in a single source file", async () => {
    const context = await selfDuplicationContext();
    const set = await duplicationAdapter.collect(context);
    const result = await observationCheckResult(
      "duplication",
      set,
      context,
      true,
    );

    expect(
      result.findings.filter(({ attribution }) => attribution.staged),
    ).toEqual([
      expect.objectContaining({
        location: expect.objectContaining({ file: "src/only.ts" }),
        attribution: expect.objectContaining({ kind: "range-overlap" }),
      }),
    ]);
  });

  it("does not scan nested workspace files for the root target", async () => {
    const context = await nestedWorkspaceContext();
    const rootWorkspace = context.targetInspection.workspaces.find(
      ({ relativeRoot }) => relativeRoot === ".",
    );
    expect(rootWorkspace?.sourceFiles).toEqual(["src/root.ts"]);

    const set = await duplicationAdapter.collect(context);
    expect(set.baselineObservations).toEqual([]);
    expect(set.targetObservations).toEqual([]);
  });

  it("fails closed when project analysis is cancelled", async () => {
    const context = await duplicationContext();
    const controller = new AbortController();
    controller.abort();

    await expect(
      duplicationAdapter.collect({ ...context, signal: controller.signal }),
    ).rejects.toThrow("Duplication analysis failed.");
  });

  it("passes configured public duplication settings into the private jscpd config", async () => {
    const context = await duplicationContext(false);
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: {
        duplication: {
          severity: "error",
          threshold: 7.5,
          settings: { minLines: 8, minTokens: 75, mode: "strict" },
        },
      },
    });
    const capturedConfigs: unknown[] = [];
    execaHarness.run = async (_file, args) => {
      const configIndex = args.indexOf("--config");
      const configPath = args[configIndex + 1];
      if (configIndex < 0 || configPath === undefined) {
        throw new Error("Expected jscpd config path");
      }
      const managedConfig = JSON.parse(await readFile(configPath, "utf8")) as {
        output?: string;
      };
      capturedConfigs.push(managedConfig);
      if (typeof managedConfig.output !== "string") {
        throw new Error("Expected managed output path");
      }
      await writeFile(
        join(managedConfig.output, "jscpd-report.json"),
        JSON.stringify({
          duplicates: [],
          statistics: { total: { percentage: 0 } },
        }),
        "utf8",
      );
      return { exitCode: 0 };
    };

    try {
      await duplicationAdapter.collect({
        ...context,
        config,
        policy: config.checks.duplication,
        policyForFile: testFilePolicyResolver(config, context.changeSet),
      });
    } finally {
      execaHarness.run = undefined;
    }

    expect(capturedConfigs).toHaveLength(2);
    for (const config of capturedConfigs) {
      expect(config).toMatchObject({
        threshold: 7.5,
        minLines: 8,
        minTokens: 75,
        mode: "strict",
        format: ["javascript", "jsx", "typescript", "tsx"],
        reporters: ["json"],
        silent: true,
        gitignore: true,
      });
      expect(config).toHaveProperty("output", expect.any(String));
    }
  });
});
