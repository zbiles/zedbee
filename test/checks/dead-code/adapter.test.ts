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
  describe("package import aliases", () => {
    async function aliasContext(
      imports: Record<string, unknown>,
      specifier = "#alias",
      extra: Parameters<typeof context>[3] = async () => undefined,
    ) {
      return context(
        "export const used = 1;\n",
        `import { value } from ${JSON.stringify(specifier)}; export const used = value;\n`,
        { imports },
        async (fixture) => {
          await fixture.write("src/dependency.ts", "export const value = 1;\n");
          await extra(fixture);
        },
      );
    }

    it.each([
      ["exact", { "#alias": "./src/dependency.ts" }, "#alias"],
      ["wildcard", { "#lib/*": "./src/*.ts" }, "#lib/dependency"],
      ["query", { "#alias": "./src/dependency.ts" }, "#alias?raw"],
      [
        "conditional",
        { "#alias": { node: "./src/dependency.ts", default: "./missing.ts" } },
        "#alias",
      ],
      ["array", { "#alias": [null, "./src/dependency.ts"] }, "#alias"],
    ] as const)("preserves a valid %s alias", async (_, imports, specifier) => {
      const result = await deadCodeAdapter.collect(
        await aliasContext(imports, specifier),
      );
      expect(result.targetObservations).toEqual([]);
    });

    it.each([
      ["package", "host-package", "#alias"],
      ["scoped package", "@host/package/subpath", "#alias"],
      ["builtin-named package", "fs", "#alias"],
      ["hash-named target", "#host", "#alias"],
      ["query spelling", "host-package", "#alias?raw"],
      ["loader spelling", "host-package", "!#alias"],
    ])(
      "refuses an ancestor dependency through a %s alias",
      async (_, destination, specifier) => {
        const packagePath = destination.startsWith("@")
          ? destination.split("/").slice(0, 2).join("/")
          : destination;
        const runContext = await aliasContext(
          { "#alias": destination },
          specifier,
          async (fixture) => {
            await fixture.writeJson(
              `node_modules/${packagePath}/package.json`,
              { name: packagePath, main: "index.js" },
            );
            await fixture.write(
              `node_modules/${packagePath}/index.js`,
              "export const value = 1;\n",
            );
            await fixture.write(
              `node_modules/${packagePath}/subpath.js`,
              "export const value = 1;\n",
            );
          },
        );
        await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
          "Dead-code analysis failed.",
        );
      },
    );

    it("refuses an ancestor dependency selected by a wildcard", async () => {
      const runContext = await aliasContext(
        { "#lib/*": "host-package/*" },
        "#lib/subpath",
        async (fixture) => {
          await fixture.write(
            "node_modules/host-package/subpath.js",
            "export const value = 1;\n",
          );
        },
      );
      await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
        "Dead-code analysis failed.",
      );
    });

    it.each([
      "const value = import('#alias', {});",
      "const value = import.meta.resolve('#alias');",
      "const value = require.resolve('#alias', {});",
      "/** @import { value } from '#alias' */",
      "import { register } from 'node:module'; register('#alias');",
      "import module from 'node:module'; module.register('#alias');",
    ])("checks alias imports in %s", async (source) => {
      const runContext = await context(
        "export const used = 1;\n",
        `${source}\nexport const used = 1;\n`,
        { imports: { "#alias": "host-package" } },
        async (fixture) => {
          await fixture.write(
            "node_modules/host-package/index.js",
            "export const value = 1;\n",
          );
        },
      );
      await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
        "Dead-code analysis failed.",
      );
    });

    it("refuses a local alias folder whose main redirects into an ignored install", async () => {
      const runContext = await aliasContext(
        { "#alias": "./redirect" },
        "#alias",
        async (fixture) => {
          await fixture.writeJson("redirect/package.json", {
            main: "../node_modules/host-package/index.js",
          });
          await fixture.write(
            "node_modules/host-package/index.js",
            "export const value = 1;\n",
          );
        },
      );
      await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
        "Dead-code analysis failed.",
      );
    });

    it("preserves a local alias folder whose main stays inside the snapshot", async () => {
      const runContext = await aliasContext(
        { "#alias": "./redirect" },
        "#alias",
        async (fixture) => {
          await fixture.writeJson("redirect/package.json", {
            main: "../src/dependency.ts",
          });
        },
      );
      expect(
        (await deadCodeAdapter.collect(runContext)).targetObservations,
      ).toEqual([]);
    });

    it("treats dollar characters in wildcard captures literally", async () => {
      const runContext = await aliasContext(
        { "#packages/*": "*" },
        "#packages/host$&package",
        async (fixture) => {
          await fixture.write(
            "node_modules/host$&package/index.js",
            "export const value = 1;\n",
          );
        },
      );
      await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
        "Dead-code analysis failed.",
      );
    });

    it("keeps nearest-package scope and exact mappings ahead of unused wildcards", async () => {
      const runContext = await aliasContext(
        { "#alias": "host-package" },
        "#alias",
        async (fixture) => {
          await fixture.writeJson("src/package.json", {
            imports: { "#*": "host-package", "#alias": "./dependency.ts" },
          });
          await fixture.write(
            "node_modules/host-package/index.js",
            "export const value = 1;\n",
          );
        },
      );
      expect(
        (await deadCodeAdapter.collect(runContext)).targetObservations,
      ).toEqual([]);
    });

    it("does not reject inactive conditions or unused array fallbacks", async () => {
      const runContext = await aliasContext(
        {
          "#alias": {
            custom: "host-package",
            default: ["./src/dependency.ts", "host-package"],
          },
        },
        "#alias",
        async (fixture) => {
          await fixture.write(
            "node_modules/host-package/index.js",
            "export const value = 1;\n",
          );
        },
      );
      expect(
        (await deadCodeAdapter.collect(runContext)).targetObservations,
      ).toEqual([]);
    });

    it("allows an absent package fallback followed by a local alias target", async () => {
      const runContext = await aliasContext({
        "#alias": ["zedbee-absent-alias-package", "./src/dependency.ts"],
      });
      expect(
        (await deadCodeAdapter.collect(runContext)).targetObservations,
      ).toEqual([]);
    });

    it("checks the browser fallback when an alias names a missing .js file beside an existing .ts file", async () => {
      const runContext = await aliasContext(
        { "#alias": { node: "./src/dependency.js", browser: "host-package" } },
        "#alias",
        async (fixture) => {
          await fixture.write(
            "node_modules/host-package/index.js",
            "export const value = 1;\n",
          );
        },
      );
      await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
        "Dead-code analysis failed.",
      );
    });

    it("checks Knip's browser lookup even when the node-condition file exists", async () => {
      const runContext = await aliasContext(
        { "#alias": { node: "./src/dependency.ts", browser: "host-package" } },
        "#alias",
        async (fixture) => {
          await fixture.write(
            "node_modules/host-package/index.js",
            "export const value = 1;\n",
          );
        },
      );
      await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
        "Dead-code analysis failed.",
      );
    });

    it("checks the browser fallback when the primary local target is missing", async () => {
      const runContext = await aliasContext(
        { "#alias": { node: "./missing.ts", browser: "host-package" } },
        "#alias",
        async (fixture) => {
          await fixture.write(
            "node_modules/host-package/index.js",
            "export const value = 1;\n",
          );
        },
      );
      await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
        "Dead-code analysis failed.",
      );
    });

    it("honors the most specific wildcard instead of an overridden package mapping", async () => {
      const runContext = await aliasContext(
        { "#lib/*": "host-package/*", "#lib/*.js": "./src/*.ts" },
        "#lib/dependency.js",
        async (fixture) => {
          await fixture.write(
            "node_modules/host-package/dependency.js",
            "export const value = 1;\n",
          );
        },
      );
      expect(
        (await deadCodeAdapter.collect(runContext)).targetObservations,
      ).toEqual([]);
    });

    it.each([
      "../outside.ts",
      "./node_modules/host-package/index.js",
      "./%2e%2e/outside.ts",
    ])("refuses an unsafe alias target %s", async (destination) => {
      await expect(
        deadCodeAdapter.collect(await aliasContext({ "#alias": destination })),
      ).rejects.toThrow("Dead-code analysis failed.");
    });

    it("validates a wildcard capture before using it as a package subpath", async () => {
      const runContext = await aliasContext(
        { "#lib/*": "host-package/*" },
        "#lib/../../outside",
      );
      await expect(deadCodeAdapter.collect(runContext)).rejects.toThrow(
        "Dead-code analysis failed.",
      );
    });

    it("reports an undefined alias without making the check incomplete", async () => {
      const runContext = await aliasContext({
        "#other": "./src/dependency.ts",
      });
      expect(
        (await deadCodeAdapter.collect(runContext)).targetObservations,
      ).toEqual([
        expect.objectContaining({
          rule: "unresolved",
          entity: expect.objectContaining({ name: "#alias" }),
        }),
      ]);
    });
  });

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
  });

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
