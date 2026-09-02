import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CheckRunContext,
  CheckTarget,
} from "../../../src/checks/adapter.js";
import { deadCodeAdapter } from "../../../src/checks/dead-code/adapter.js";
import { dispatchChecks } from "../../../src/checks/dispatcher.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

const target: CheckTarget = { id: ".", kind: "workspace", relativeRoot: "." };

function changes(path: string): ChangeSet {
  return {
    files: new Map([
      [
        path,
        {
          path,
          status: "modified",
          addedRanges: [{ start: 1, end: 1 }],
        },
      ],
    ]),
    isEmpty: false,
    containsAddedLine(file, line) {
      return file === path && line === 1;
    },
  };
}

async function context(
  baselineLib: string,
  stagedLib: string,
  stagedManifest: Record<string, unknown> = {},
  extra: (
    fixture: Awaited<ReturnType<typeof createInspectionFixture>>,
  ) => Promise<void> = async () => undefined,
): Promise<CheckRunContext> {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, live]) {
    await fixture.writeJson("package.json", {
      name: "fixture",
      private: true,
      main: "src/index.ts",
      ...stagedManifest,
    });
  }
  for (const fixture of [baseline, staged, live]) await extra(fixture);
  await staged.writeJson("package.json", {
    name: "fixture",
    private: true,
    main: "src/index.ts",
    ...stagedManifest,
  });
  for (const fixture of [baseline, staged, live]) {
    await fixture.write(
      "src/index.ts",
      "import { used } from './lib.js'; console.log(used);\n",
    );
  }
  await baseline.write("src/lib.ts", baselineLib);
  await staged.write("src/lib.ts", stagedLib);
  await live.write("src/lib.ts", "export const used = 'live';\n");
  const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
  return {
    repositoryRoot: live.root,
    changeSet: changes("src/lib.ts"),
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
    policy: config.checks.deadCode,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

async function stagedFindings(runContext: CheckRunContext) {
  const set = await deadCodeAdapter.collect(runContext);
  const result = await observationCheckResult(
    "deadCode",
    set,
    runContext,
    true,
  );
  return result.findings.filter(({ attribution }) => attribution.staged);
}

describe("deadCodeAdapter", () => {
  it("keeps existing unused exports as debt and attributes a new unused export", async () => {
    const runContext = await context(
      "export const used = 1; export const existing = 2;\n",
      "export const used = 1; export const existing = 2; export const fresh = 3;\n",
    );
    await expect(deadCodeAdapter.inspect(runContext)).resolves.toMatchObject({
      applies: true,
      executionClass: "project-analysis",
      requiresBaseline: true,
      targets: [target],
    });
    expect(await stagedFindings(runContext)).toEqual([
      expect.objectContaining({
        check: "deadCode",
        rule: "exports",
        location: expect.objectContaining({ file: "src/lib.ts" }),
      }),
    ]);
  });

  it("reports a newly unlisted package without executing knip.ts", async () => {
    const runContext = await context(
      "export const used = 1;\n",
      "import value from 'missing-package'; export const used = value;\n",
      { devDependencies: { vite: "7.0.0" } },
      async (fixture) => {
        await fixture.write(
          "knip.ts",
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(fixture.root, "KNIP_EXECUTED"))}, 'bad');\n`,
        );
        await fixture.write(
          "vite.config.ts",
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(fixture.root, "VITE_EXECUTED"))}, 'bad'); export default {};\n`,
        );
      },
    );
    expect(await stagedFindings(runContext)).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "unlisted" })]),
    );
    for (const root of [
      runContext.snapshots.baselineDir,
      runContext.snapshots.targetDir,
      runContext.repositoryRoot,
    ]) {
      for (const marker of ["KNIP_EXECUTED", "VITE_EXECUTED"]) {
        await expect(access(join(root, marker))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
  });

  it("attributes a dependency made unused by staged source", async () => {
    const runContext = await context(
      "import leftPad from 'left-pad'; export const used = leftPad;\n",
      "export const used = 1;\n",
      { dependencies: { "left-pad": "1.3.0" } },
    );
    expect(await stagedFindings(runContext)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "dependencies",
          location: expect.objectContaining({ file: "package.json" }),
          attribution: expect.objectContaining({
            staged: true,
            evidence: expect.arrayContaining(["project-delta"]),
          }),
        }),
      ]),
    );
  });

  it("completes a staged manifest change while retaining old and newly unused dependencies", async () => {
    const original = await context(
      "export const used = 1;\n",
      "export const used = 1;\n",
      { dependencies: { "left-pad": "1.3.0" } },
    );
    await writeFile(
      join(original.snapshots.targetDir, "package.json"),
      JSON.stringify({
        name: "fixture",
        private: true,
        main: "src/index.ts",
        dependencies: { "left-pad": "1.3.0", "is-number": "7.0.0" },
      }),
    );
    const runContext = {
      ...original,
      changeSet: changes("package.json"),
      targetInspection: await inspectRepository(original.snapshots.targetDir),
    };

    const [execution] = await dispatchChecks([deadCodeAdapter], runContext);

    expect(execution?.result.status).toBe("completed");
    expect(execution?.result.findings).toHaveLength(2);
    expect(execution?.result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "dependencies",
          location: expect.objectContaining({ file: "package.json" }),
          attribution: expect.objectContaining({ staged: false }),
        }),
        expect.objectContaining({
          rule: "dependencies",
          location: expect.objectContaining({ file: "package.json" }),
          attribution: expect.objectContaining({
            staged: true,
            evidence: expect.arrayContaining(["project-delta"]),
          }),
        }),
      ]),
    );
  });

  it("keeps the same unused export as baseline debt when its line moves", async () => {
    const runContext = await context(
      "export const used = 1; export const existing = 2;\n",
      "// staged comment\nexport const used = 1; export const existing = 2;\n",
    );
    expect(await stagedFindings(runContext)).toEqual([]);
  }, 30_000);

  it("fails closed when a relative import escapes the snapshot", async () => {
    const runContext = await context(
      "export const used = 1;\n",
      "import '../../outside.js'; export const used = 1;\n",
    );
    await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
      "Dead-code analysis failed.",
    );
  });

  it("fails closed when an import type escapes the snapshot", async () => {
    const runContext = await context(
      "export const used = 1;\n",
      "type Escaped = import('../../outside.js').Value; export const used: Escaped | number = 1;\n",
    );
    await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
      "Dead-code analysis failed.",
    );
  });

  it("fails closed instead of resolving an ancestor node_modules package", async () => {
    const runContext = await context(
      "export const used = 1;\n",
      "import value from 'host-package'; export const used = value;\n",
      {},
      async (fixture) => {
        await fixture.write(
          "node_modules/host-package/index.js",
          "export default 'outside snapshot inventory';\n",
        );
      },
    );
    await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
      "Dead-code analysis failed.",
    );
  });

  it("fails closed when require.resolve targets ancestor node_modules", async () => {
    const runContext = await context(
      "export const used = 1;\n",
      "export const used = require.resolve('host-package');\n",
      {},
      async (fixture) => {
        await fixture.write(
          "node_modules/host-package/index.js",
          "export default 'outside snapshot inventory';\n",
        );
      },
    );
    await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
      "Dead-code analysis failed.",
    );
  });

  it("fails closed when already cancelled", async () => {
    const runContext = await context(
      "export const used = 1;\n",
      "export const used = 1; export const fresh = 2;\n",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      deadCodeAdapter.collect({ ...runContext, signal: controller.signal }),
    ).rejects.toThrow("Dead-code analysis failed.");
  });
});
