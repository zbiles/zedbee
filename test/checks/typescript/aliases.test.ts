import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { deadCodeAdapter } from "../../../src/checks/dead-code/adapter.js";
import { createManagedKnipConfig } from "../../../src/checks/dead-code/managed-config.js";
import { dependencyArchitectureAdapter } from "../../../src/checks/dependency-architecture/adapter.js";
import { loadSnapshotAliases } from "../../../src/checks/typescript/aliases.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

async function aliasContext(
  files: Readonly<Record<string, string>>,
  compilerOptions: Record<string, unknown> = { paths: { "@/*": ["./src/*"] } },
  nested = false,
) {
  const fixture = await createInspectionFixture();
  const prefix = nested ? ".worktrees/branch/" : "";
  await fixture.writeJson(`${prefix}package.json`, {
    name: "alias-fixture",
    private: true,
    type: "module",
    main: "src/index.ts",
  });
  await fixture.writeJson(`${prefix}tsconfig.json`, {
    compilerOptions: {
      module: "esnext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      ...compilerOptions,
    },
    include: ["**/*.ts", "**/*.tsx"],
    exclude: ["node_modules", ".worktrees"],
  });
  for (const [path, source] of Object.entries(files))
    await fixture.write(`${prefix}${path}`, source);
  const root = nested ? join(fixture.root, ".worktrees/branch") : fixture.root;
  const inspection = await inspectRepository(root);
  const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
  const context: CheckRunContext = {
    repositoryRoot: root,
    changeSet: {
      files: new Map([
        [
          "src/index.ts",
          {
            path: "src/index.ts",
            status: "modified",
            addedRanges: [{ start: 1, end: 1 }],
          },
        ],
      ]),
      isEmpty: false,
      containsAddedLine: () => true,
    },
    config,
    snapshots: {
      baselineDir: root,
      targetDir: root,
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
    },
    baselineInspection: inspection,
    targetInspection: inspection,
    target: { id: ".", kind: "workspace", relativeRoot: "." },
    policy: config.checks.deadCode,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
  return { context, fixture, root };
}

async function observations(context: CheckRunContext) {
  const deadCode = await deadCodeAdapter.collect(context);
  const architecture = await dependencyArchitectureAdapter.collect({
    ...context,
    policy: context.config.checks.dependencyArchitecture,
  });
  return {
    deadCode: deadCode.targetObservations,
    architecture: architecture.targetObservations,
  };
}

describe("snapshot TypeScript aliases", () => {
  it("resolves a catch-all mapping without reapplying it to the captured absolute target", async () => {
    const { context } = await aliasContext(
      {
        "src/index.ts": "import { used } from 'value'; console.log(used);",
        "src/value.ts": "export const used = 1; export const unused = 2;",
      },
      { paths: { "*": ["src/*"] } },
    );
    const result = await observations(context);
    expect(result.architecture).toEqual([]);
    expect(
      result.deadCode.map(({ rule, entity }) => [rule, entity?.name]),
    ).toEqual([["exports", "unused"]]);
    const aliases = await loadSnapshotAliases(
      context.targetInspection.snapshotRoot,
      context.targetInspection.workspaces[0]!,
    );
    for (const specifier of [
      join(context.targetInspection.snapshotRoot, "src/value.ts"),
      "C:/project/src/value.ts",
      "C:\\project\\src\\value.ts",
      "https://example.test/value",
      "node:fs",
    ])
      expect(aliases.resolve("src/index.ts", specifier)).toBeUndefined();
  });

  it("does not rescue a missing relative stylesheet through a catch-all mapping", async () => {
    const { context } = await aliasContext(
      {
        "src/index.ts": "import './nested/entry';",
        "src/nested/entry.ts": "import './style.css';",
        "src/style.css": ".fixture { color: blue; }",
      },
      { paths: { "*": ["src/*"] } },
    );
    const result = await dependencyArchitectureAdapter.collect(context);
    expect(result.targetObservations).toEqual([
      expect.objectContaining({
        rule: "no-unresolved",
        location: { file: "src/nested/entry.ts" },
      }),
    ]);
    const aliases = await loadSnapshotAliases(
      context.targetInspection.snapshotRoot,
      context.targetInspection.workspaces[0]!,
    );
    expect(
      aliases.resolve("src/nested/entry.ts", "./style.css"),
    ).toBeUndefined();
  });

  it.each([false, true])(
    "resolves a bundler alias without baseUrl under nested worktree=%s",
    async (nested) => {
      const { context } = await aliasContext(
        {
          "src/index.ts": "import { used } from '@/policy'; console.log(used);",
          "src/policy.ts": "export const used = 1; export const unused = 2;",
        },
        undefined,
        nested,
      );
      const result = await observations(context);
      expect(result.architecture).toEqual([]);
      expect(
        result.deadCode.map(({ rule, entity }) => [rule, entity?.name]),
      ).toEqual([["exports", "unused"]]);
    },
  );

  it("uses inherited path origins and ordered fallback substitutions", async () => {
    const { context, fixture, root } = await aliasContext(
      {
        "src/index.ts": "import { used } from '@/policy'; console.log(used);",
        "src/policy.ts": "export const used = 1; export const unused = 2;",
        "config/base.json": JSON.stringify({
          compilerOptions: { paths: { "@/*": ["./missing/*", "../src/*"] } },
        }),
      },
      {},
    );
    await fixture.writeJson("tsconfig.json", {
      extends: "./config/base.json",
      compilerOptions: { module: "esnext", moduleResolution: "bundler" },
      include: ["src"],
    });
    const inspection = await inspectRepository(root);
    const result = await observations({
      ...context,
      baselineInspection: inspection,
      targetInspection: inspection,
    });
    expect(result.architecture).toEqual([]);
    expect(
      result.deadCode.map(({ rule, entity }) => [rule, entity?.name]),
    ).toEqual([["exports", "unused"]]);
  });

  it("keeps alias consumers reachable through a TSX component imported by a Node test", async () => {
    const { context, fixture, root } = await aliasContext({
      "src/index.ts": "import { policy } from './policy'; console.log(policy);",
      "tests/render.test.ts":
        "import { Component } from '../src/component.tsx'; console.log(Component());",
      "src/component.tsx":
        "import { motionAllowedNow } from '@/policy'; export function Component() { return motionAllowedNow(); }",
      "src/policy.ts":
        "export const policy = true; export function motionAllowedNow() { return true; } export const unused = 1;",
    });
    await fixture.writeJson("package.json", {
      name: "alias-fixture",
      private: true,
      type: "module",
      main: "tests/render.test.ts",
      exports: "./src/index.ts",
    });
    const inspection = await inspectRepository(root);
    const result = await observations({
      ...context,
      baselineInspection: inspection,
      targetInspection: inspection,
    });
    expect(
      result.deadCode.map(({ rule, entity }) => [rule, entity?.name]),
    ).toEqual([["exports", "unused"]]);
    expect(result.architecture).toEqual([]);
  });

  it("follows alias edges to detect an actual cycle", async () => {
    const { context } = await aliasContext({
      "src/index.ts": "import { b } from '@/b'; export const a = b;",
      "src/b.ts": "import { a } from '@/index'; export const b = a;",
    });
    const result = await observations(context);
    expect(result.architecture.map(({ rule }) => rule)).toEqual([
      "no-circular",
      "no-circular",
    ]);
    expect(result.deadCode).toEqual([]);
  });

  it.each(["@", "utils"])(
    "still reports a genuinely missing %s alias",
    async (prefix) => {
      const { context } = await aliasContext(
        {
          "src/index.ts": `import { missing } from '${prefix}/missing'; console.log(missing);`,
        },
        { paths: { [`${prefix}/*`]: ["./src/*"] } },
      );
      const result = await observations(context);
      expect(result.deadCode).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: prefix === "utils" ? "unlisted" : "unresolved",
            entity: expect.objectContaining({
              name: prefix === "utils" ? "utils" : `${prefix}/missing`,
            }),
          }),
        ]),
      );
      expect(result.architecture).toEqual([
        expect.objectContaining({
          rule: "no-unresolved",
          message: expect.stringContaining(`${prefix}/missing`),
        }),
      ]);
      expect(result.architecture[0]?.message).toContain("tsconfig.json");
    },
  );

  it.each(["", "?raw"])(
    "resolves an existing stylesheet alias with suffix %s",
    async (suffix) => {
      const { context } = await aliasContext({
        "src/index.ts": `import '@/style.css${suffix}'; console.log('ready');`,
        "src/style.css": ".fixture { color: blue; }",
      });
      expect(await observations(context)).toEqual({
        deadCode: [],
        architecture: [],
      });
    },
  );

  it("selects an exact alias before overlapping wildcard aliases", async () => {
    const { context } = await aliasContext(
      {
        "src/index.ts": "import { used } from '@/exact'; console.log(used);",
        "src/exact.ts": "export const wrong = 1;",
        "exact.ts": "export const used = 1; export const unused = 2;",
      },
      { paths: { "@/*": ["src/*"], "@/exact": ["exact.ts"] } },
    );
    const result = await observations(context);
    expect(result.architecture).toEqual([]);
    expect(result.deadCode).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "exports",
          entity: expect.objectContaining({ name: "unused", file: "exact.ts" }),
        }),
      ]),
    );
    expect(result.deadCode.some(({ rule }) => rule === "unresolved")).toBe(
      false,
    );
  });

  it("does not fall back to a less specific wildcard when the selected alias is missing", async () => {
    const { context } = await aliasContext(
      {
        "src/index.ts":
          "import { used } from '@/special/value'; console.log(used);",
        "src/special/value.ts": "export const used = 1;",
      },
      { paths: { "@/*": ["src/*"], "@/special/*": ["special/*"] } },
    );
    const result = await observations(context);
    expect(result.architecture).toEqual([
      expect.objectContaining({ rule: "no-unresolved" }),
    ]);
    expect(result.deadCode).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "unresolved" })]),
    );
  });

  it("rejects an alias whose expanded wildcard escapes the snapshot", async () => {
    const { context } = await aliasContext({
      "src/index.ts":
        "import { value } from '@/../../outside'; console.log(value);",
    });
    await expect(deadCodeAdapter.collect(context)).rejects.toThrow(
      "Dead-code analysis failed.",
    );
    await expect(
      dependencyArchitectureAdapter.collect(context),
    ).rejects.toThrow("Dependency architecture analysis failed.");
  });

  it("does not expose host snapshot paths in the inert Knip configuration", async () => {
    const { context, root } = await aliasContext({
      "src/index.ts": "import { used } from '@/policy'; console.log(used);",
      "src/policy.ts": "export const used = 1;",
    });
    const managed = await createManagedKnipConfig(
      context.targetInspection.snapshotRoot,
      context.targetInspection,
    );
    expect(managed.workspaces["."]).toHaveProperty("paths");
    expect(JSON.stringify(managed)).not.toContain(root);
  });

  it("uses the more specific wildcard when both targets exist", async () => {
    const { context } = await aliasContext(
      {
        "src/index.ts":
          "import { used } from '@/special/value'; console.log(used);",
        "src/special/value.ts": "export const wrong = 1;",
        "special/value.ts": "export const used = 1; export const unused = 2;",
      },
      { paths: { "@/*": ["src/*"], "@/special/*": ["special/*"] } },
    );
    const result = await observations(context);
    expect(result.architecture).toEqual([]);
    expect(result.deadCode).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "exports",
          entity: expect.objectContaining({
            name: "unused",
            file: "special/value.ts",
          }),
        }),
      ]),
    );
    expect(
      result.deadCode.some(
        ({ rule }) => rule === "unresolved" || rule === "unlisted",
      ),
    ).toBe(false);
  });

  it("honors an explicit baseUrl when resolving path substitutions", async () => {
    const { context } = await aliasContext(
      {
        "src/index.ts": "import { used } from '@/value'; console.log(used);",
        "src/value.ts": "export const used = 1; export const unused = 2;",
      },
      { baseUrl: "src", paths: { "@/*": ["*"] } },
    );
    const result = await observations(context);
    expect(result.architecture).toEqual([]);
    expect(
      result.deadCode.map(({ rule, entity }) => [rule, entity?.name]),
    ).toEqual([["exports", "unused"]]);
  });

  it("does not read an installed package that collides with a valid local alias", async () => {
    const { context, fixture } = await aliasContext(
      {
        "src/index.ts":
          "import { used } from 'utils/value'; console.log(used);",
        "src/value.ts": "export const used = 1; export const unused = 2;",
      },
      { paths: { "utils/*": ["src/*"] } },
    );
    await fixture.writeJson("node_modules/utils/package.json", {
      name: "utils",
      main: "value.js",
    });
    await fixture.write(
      "node_modules/utils/value.js",
      "throw new Error('Host package must not be read');",
    );
    const result = await observations(context);
    expect(result.architecture).toEqual([]);
    expect(
      result.deadCode.map(({ rule, entity }) => [rule, entity?.name]),
    ).toEqual([["exports", "unused"]]);
  });

  it("does not require an unrelated workspace package for a captured local alias", async () => {
    const { context, fixture, root } = await aliasContext(
      {
        "src/index.ts":
          "import { used } from 'utils/value'; console.log(used);",
        "src/value.ts": "export const used = 1; export const unused = 2;",
      },
      { paths: { "utils/*": ["src/*"] } },
    );
    await fixture.writeJson("package.json", {
      name: "alias-fixture",
      private: true,
      main: "src/index.ts",
      workspaces: ["packages/*"],
    });
    await fixture.writeJson("packages/utils/package.json", {
      name: "utils",
      exports: { "./value": "./src/value.ts" },
    });
    await fixture.write(
      "packages/utils/src/value.ts",
      "export const used = 99;",
    );
    const inspection = await inspectRepository(root);
    const result = await dependencyArchitectureAdapter.collect({
      ...context,
      baselineInspection: inspection,
      targetInspection: inspection,
    });
    expect(result.targetObservations).toEqual([]);
  });

  it.each([
    ["style.css", ".fixture { color: blue; }"],
    ["data.json", '{"value":1}'],
  ])(
    "does not require an unrelated workspace package for local asset %s",
    async (file, contents) => {
      const { context, fixture, root } = await aliasContext(
        {
          "src/index.ts": `import 'foo/${file}'; console.log('ready');`,
          [`src/${file}`]: contents,
        },
        { paths: { "foo/*": ["src/*"] }, resolveJsonModule: true },
      );
      await fixture.writeJson("package.json", {
        name: "alias-fixture",
        private: true,
        main: "src/index.ts",
        workspaces: ["packages/*"],
      });
      await fixture.writeJson("packages/foo/package.json", {
        name: "foo",
        main: "src/index.ts",
      });
      await fixture.write(
        "packages/foo/src/index.ts",
        "export const unrelated = 1;",
      );
      const inspection = await inspectRepository(root);
      const result = await dependencyArchitectureAdapter.collect({
        ...context,
        baselineInspection: inspection,
        targetInspection: inspection,
      });
      expect(result.targetObservations).toEqual([]);
    },
  );

  it("still requires a workspace declaration when an asset alias resolves into that workspace", async () => {
    const { context, fixture, root } = await aliasContext(
      {
        "src/index.ts": "import 'foo/style.css'; console.log('ready');",
        "packages/foo/src/style.css": ".fixture { color: blue; }",
      },
      { paths: { "foo/*": ["packages/foo/src/*"] } },
    );
    await fixture.writeJson("package.json", {
      name: "alias-fixture",
      private: true,
      main: "src/index.ts",
      workspaces: ["packages/*"],
    });
    await fixture.writeJson("packages/foo/package.json", {
      name: "foo",
      main: "src/index.ts",
    });
    await fixture.write(
      "packages/foo/src/index.ts",
      "export const unrelated = 1;",
    );
    const inspection = await inspectRepository(root);
    const result = await dependencyArchitectureAdapter.collect({
      ...context,
      baselineInspection: inspection,
      targetInspection: inspection,
    });
    expect(result.targetObservations).toEqual([
      expect.objectContaining({
        rule: "no-missing-dependency",
        location: { file: "src/index.ts" },
      }),
    ]);
  });

  it.each([
    "void import('@/../../outside', { with: { type: 'json' } });",
    "export type Value = import('@/../../outside').Value;",
  ])(
    "validates alias expansion in %s before graph resolution",
    async (source) => {
      const { context } = await aliasContext({ "src/index.ts": source });
      await expect(deadCodeAdapter.collect(context)).rejects.toThrow(
        "Dead-code analysis failed.",
      );
      await expect(
        dependencyArchitectureAdapter.collect(context),
      ).rejects.toThrow("Dependency architecture analysis failed.");
    },
  );

  it("does not load an unrelated workspace's invalid TypeScript config", async () => {
    const { context, fixture, root } = await aliasContext({
      "src/index.ts": "import { used } from '@/value'; console.log(used);",
      "src/value.ts": "export const used = 1;",
    });
    await fixture.writeJson("package.json", {
      name: "alias-fixture",
      private: true,
      main: "src/index.ts",
      workspaces: ["packages/*"],
    });
    await fixture.writeJson("packages/untouched/package.json", {
      name: "untouched",
      main: "src/index.ts",
    });
    await fixture.writeJson("packages/untouched/tsconfig.json", {
      extends: "../../../../outside.json",
    });
    await fixture.write(
      "packages/untouched/src/index.ts",
      "export const untouched = 1;",
    );
    const inspection = await inspectRepository(root);
    const result = await observations({
      ...context,
      baselineInspection: inspection,
      targetInspection: inspection,
    });
    expect(result).toEqual({ deadCode: [], architecture: [] });
  });

  it("uses each followed workspace's own alias scope", async () => {
    const { context, fixture, root } = await aliasContext({
      "src/index.ts": "console.log('root');",
    });
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      main: "src/index.ts",
      workspaces: ["packages/*"],
    });
    for (const [name, other] of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      await fixture.writeJson(`packages/${name}/package.json`, {
        name: `@fixture/${name}`,
        exports: "./src/index.ts",
        dependencies: { [`@fixture/${other}`]: "workspace:*" },
      });
      await fixture.writeJson(`packages/${name}/tsconfig.json`, {
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          paths: { "@/*": ["./src/*"] },
        },
        include: ["src"],
      });
      await fixture.write(
        `packages/${name}/src/index.ts`,
        `import { ${other} } from '@fixture/${other}'; import { own } from '@/value'; export const ${name} = ${other} + own;`,
      );
      await fixture.write(
        `packages/${name}/src/value.ts`,
        "export const own = 1;",
      );
    }
    const inspection = await inspectRepository(root);
    const result = await observations({
      ...context,
      target: {
        id: "packages/a",
        kind: "workspace",
        relativeRoot: "packages/a",
      },
      baselineInspection: inspection,
      targetInspection: inspection,
    });
    expect(result.deadCode).toEqual([]);
    expect(result.architecture).toEqual([
      expect.objectContaining({
        rule: "no-circular",
        location: { file: "packages/a/src/index.ts" },
      }),
    ]);
  });

  it("treats a one-character workspace as more specific than artificial root dot", async () => {
    const { context, fixture, root } = await aliasContext({
      "src/index.ts":
        "import { fromA } from '@/../a/src/index'; console.log(fromA);",
      "src/value.ts":
        "import { fromA } from '@/../a/src/index'; export const used = fromA;",
      "a/src/index.ts":
        "import { used } from '@/value'; export const fromA = used;",
      "a/src/value.ts": "export const used = 1;",
    });
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      main: "src/index.ts",
      workspaces: ["a"],
    });
    await fixture.writeJson("a/package.json", {
      name: "a",
      exports: "./src/index.ts",
    });
    await fixture.writeJson("a/tsconfig.json", {
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        paths: { "@/*": ["./src/*"] },
      },
      include: ["src"],
    });
    const discovered = await inspectRepository(root);
    // Isolate resolver scope from the inspection layer's pre-existing dot/a tie.
    const inspection = {
      ...discovered,
      workspaces: discovered.workspaces.map((workspace) => ({
        ...workspace,
        sourceFiles:
          workspace.relativeRoot === "."
            ? ["src/index.ts", "src/value.ts"]
            : ["a/src/index.ts", "a/src/value.ts"],
        tsconfigPaths:
          workspace.relativeRoot === "."
            ? ["tsconfig.json"]
            : ["a/tsconfig.json"],
      })),
    };
    const result = await dependencyArchitectureAdapter.collect({
      ...context,
      baselineInspection: inspection,
      targetInspection: inspection,
    });
    expect(result.targetObservations).toEqual([]);
  });

  it("does not load another scope's config for a missing relative target", async () => {
    const { context, fixture, root } = await aliasContext({
      "src/index.ts": "console.log('root');",
    });
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      main: "src/index.ts",
      workspaces: ["packages/*"],
    });
    await fixture.writeJson("tsconfig.json", { extends: "../outside.json" });
    await fixture.writeJson("packages/a/package.json", {
      name: "@fixture/a",
      main: "src/index.ts",
    });
    await fixture.writeJson("packages/a/tsconfig.json", {
      compilerOptions: { moduleResolution: "bundler", module: "esnext" },
      include: ["src"],
    });
    await fixture.write(
      "packages/a/src/index.ts",
      "import missing from '../../../missing'; console.log(missing);",
    );
    const inspection = await inspectRepository(root);
    const result = await deadCodeAdapter.collect({
      ...context,
      target: {
        id: "packages/a",
        kind: "workspace",
        relativeRoot: "packages/a",
      },
      baselineInspection: inspection,
      targetInspection: inspection,
    });
    expect(result.targetObservations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "unresolved" })]),
    );
  });
});
