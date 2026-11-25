import { chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { classifyCompilerChanges } from "../../src/checks/compiler-change-inputs.js";
import { compilerInputRelevance } from "../../src/checks/compiler-inputs.js";
import { describe, expect, it } from "vitest";
import { inspectManagedCheck } from "../../src/checks/applicability.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import type { ChangedFile } from "../../src/git/change-set.js";

async function fixtureContext(
  path: string,
  previousPath?: string,
  contents?: string,
) {
  const fixture = await createInspectionFixture();
  await fixture.writeJson("package.json", { name: "synthetic" });
  await fixture.writeJson("tsconfig.json", { include: ["src"] });
  await fixture.write("src/index.ts", "export const value = 1;\n");
  if (contents !== undefined) await fixture.write(path, contents);
  const inspection = await inspectRepository(fixture.root);
  const file = {
    path,
    status: previousPath === undefined ? "modified" : "renamed",
    addedRanges: [],
    ...(previousPath === undefined ? {} : { previousPath }),
  } as ChangedFile;
  return {
    repositoryRoot: fixture.root,
    baselineInspection: inspection,
    targetInspection: inspection,
    config: resolveConfig({ schemaVersion: 1, profile: "recommended" }),
    changeSet: {
      files: new Map([[path, file]]),
      isEmpty: false,
      containsAddedLine: () => false,
    },
  };
}

describe("compiler input scheduling", () => {
  it.each([
    "script.py",
    "api/pyproject.toml",
    "types.pyi",
    "README.md",
    "guide.markdown",
    "guide.rst",
    "notes.txt",
    ".gitignore",
    "README.MD",
  ])("skips compiler checks for ordinary %s", async (path) => {
    const context = await fixtureContext(path);
    for (const check of ["types", "lint"] as const)
      expect(await inspectManagedCheck(check, context)).toMatchObject({
        applies: false,
      });
  });

  it.each([
    "sibling/index.ts",
    "sibling/index.JS",
    "types.d.ts",
    "values.json",
    "values.JSONC",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "input.custom",
    "api/other.toml",
    "docs/other.yaml",
  ])("keeps conservative compiler coverage for %s", async (path) => {
    const context = await fixtureContext(path);
    for (const check of ["types", "lint"] as const)
      expect(await inspectManagedCheck(check, context)).toMatchObject({
        applies: true,
      });
  });

  it.each([
    ["removed.md", "src/old.ts"],
    ["docs/openapi.yaml", "src/old.ts"],
    ["api/pyproject.toml", "src/old.ts"],
    ["src/new.ts", "old.md"],
  ])("checks both rename names: %s from %s", async (path, previousPath) => {
    const context = await fixtureContext(path!, previousPath);
    expect(await inspectManagedCheck("types", context)).toMatchObject({
      applies: true,
    });
  });

  it("retains forced compiler comparisons for unrelated edits", async () => {
    const context = await fixtureContext("script.py");
    context.config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { types: { when: "always" }, lint: { when: "always" } },
    });
    for (const check of ["types", "lint"] as const)
      expect(await inspectManagedCheck(check, context)).toMatchObject({
        applies: true,
      });
  });
});

describe("compiler configuration metadata boundaries", () => {
  it.each([
    "config/compiler.md",
    "config/compiler.py",
    "config/compiler.txt",
    "api/pyproject.toml",
  ])("does not classify inherited %s as unrelated", async (path) => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "synthetic" });
    await fixture.write("src/index.ts", "export const value = 1;\n");
    await fixture.writeJson("tsconfig.json", { extends: `./${path}` });
    await fixture.writeJson(path, {});
    const inspection = await inspectRepository(fixture.root);
    const context = {
      ...(await fixtureContext(path)),
      baselineInspection: inspection,
      targetInspection: inspection,
    };
    expect(await inspectManagedCheck("types", context)).toMatchObject({
      applies: true,
    });
  });

  it.each([
    "{ broken",
    JSON.stringify({ extends: "./missing.md" }),
    JSON.stringify({ extends: "external-config-package" }),
    JSON.stringify({ extends: 42 }),
    JSON.stringify({ references: [{ path: 42 }] }),
    JSON.stringify({ references: "invalid" }),
    JSON.stringify({ extends: "../../outside.md" }),
  ])("retains unknown coverage for incomplete metadata %s", async (config) => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "synthetic" });
    await fixture.write("src/index.ts", "export const value = 1;\n");
    await fixture.write("tsconfig.json", config);
    const inspection = await inspectRepository(fixture.root);
    const context = {
      ...(await fixtureContext("script.py")),
      baselineInspection: inspection,
      targetInspection: inspection,
    };
    expect(await inspectManagedCheck("types", context)).toMatchObject({
      applies: true,
    });
  });

  it("checks baseline-only inherited config dependencies and records missing candidates", async () => {
    const baseline = await createInspectionFixture();
    const target = await createInspectionFixture();
    for (const fixture of [baseline, target]) {
      await fixture.writeJson("package.json", { name: "synthetic" });
      await fixture.write("src/index.ts", "export const value = 1;\n");
    }
    await baseline.writeJson("tsconfig.json", { extends: "./compiler.md" });
    await baseline.writeJson("compiler.md", {});
    await target.writeJson("tsconfig.json", {});
    const context = {
      ...(await fixtureContext("compiler.md")),
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(target.root),
    };
    expect(await inspectManagedCheck("types", context)).toMatchObject({
      applies: true,
    });
  });
});

// Relevance must remain conservative when metadata discovery cannot establish
// the selected input closure, without following escaped paths.
describe("compiler metadata completeness", () => {
  it("records missing contained config candidates and keeps path-only compatibility", async () => {
    const {
      createCompilerConfigurationInputResolver,
      createCompilerConfigurationResolver,
    } = await import("../../src/checks/typescript/configuration-paths.js");
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "synthetic" });
    await fixture.writeJson("tsconfig.json", {
      extends: "./missing.md",
      references: [{ path: "./directory" }],
    });
    await fixture.writeJson("directory/tsconfig.json", {});
    const inspection = await inspectRepository(fixture.root);
    const workspace = inspection.workspaces[0]!;
    const inputs = await createCompilerConfigurationInputResolver(
      inspection.snapshotRoot,
    )(workspace);
    expect(inputs.complete).toBe(false);
    expect([...inputs.paths]).toEqual(
      expect.arrayContaining([
        "tsconfig.json",
        "missing.md",
        "missing.md.json",
        "missing.md/tsconfig.json",
        "directory/tsconfig.json",
      ]),
    );
    expect([
      ...(await createCompilerConfigurationResolver(inspection.snapshotRoot)(
        workspace,
      )),
    ]).toEqual(
      expect.arrayContaining(["tsconfig.json", "directory/tsconfig.json"]),
    );
    expect(
      (
        await createCompilerConfigurationResolver(inspection.snapshotRoot)(
          workspace,
        )
      ).has("missing.md"),
    ).toBe(false);
  });

  it("shares a decision across stable selected inspections and changed-path identities", async () => {
    const { compilerInputRelevance } =
      await import("../../src/checks/compiler-inputs.js");
    const context = await fixtureContext("script.py");
    const workspace = context.targetInspection.workspaces[0]!;
    const first = compilerInputRelevance(context, workspace);
    expect(compilerInputRelevance({ ...context }, workspace)).toBe(first);
    expect(await first).toEqual({ relevant: false, reason: "unrelated" });
    const changedContext = await fixtureContext("unknown.asset");
    expect(
      await compilerInputRelevance(
        { ...context, changeSet: changedContext.changeSet },
        workspace,
      ),
    ).toEqual({ relevant: true, reason: "unknown" });
  });

  it("allows project formatters to decide support for a custom changed format", async () => {
    const context = await fixtureContext("value.fixturetxt");
    context.config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: { engine: "project" } },
    });
    expect(await inspectManagedCheck("formatting", context)).toMatchObject({
      applies: true,
    });
  });
});

it("skips provably closed sibling compiler projects but keeps importing projects", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "root",
    workspaces: ["web", "isolated", "importing"],
  });
  for (const name of ["web", "isolated", "importing"]) {
    await f.writeJson(`${name}/package.json`, { name, private: true });
    await f.writeJson(`${name}/tsconfig.json`, {
      compilerOptions: { strict: true, types: [] },
      include: ["src"],
    });
    await f.write(
      `${name}/src/value.ts`,
      name === "importing"
        ? 'import {value} from "../../web/src/value"; export {value};'
        : "export const value = 1;",
    );
  }
  const inspection = await inspectRepository(f.root);
  const context = {
    ...(await fixtureContext("web/src/value.ts")),
    baselineInspection: inspection,
    targetInspection: inspection,
  };
  for (const check of ["lint", "types"] as const) {
    const result = await inspectManagedCheck(check, context);
    if (!result.applies) throw new Error("Expected compiler targets");
    expect(result.targets?.map((t) => t.relativeRoot)).toContain("web");
    expect(result.targets?.map((t) => t.relativeRoot)).toContain("importing");
    expect(result.targets?.map((t) => t.relativeRoot)).not.toContain(
      "isolated",
    );
  }
});

it.each([
  'import "../../web/src/value"; export const value=1;',
  'export const value=()=>require("../../web/src/value");',
  "declare global { const shared: number } export {};",
  "const shared = 1;",
  '/// <reference path="../../web/src/value.ts" />\nexport {};',
])("retains unknown sibling coverage for %s", async (source) => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "root",
    workspaces: ["web", "sibling"],
  });
  for (const name of ["web", "sibling"]) {
    await f.writeJson(`${name}/package.json`, { name });
    await f.writeJson(`${name}/tsconfig.json`, {
      compilerOptions: { types: [] },
      include: ["src"],
    });
    await f.write(
      `${name}/src/value.ts`,
      name === "sibling" ? source : "export const value=1;",
    );
  }
  const inspection = await inspectRepository(f.root);
  const context = {
    ...(await fixtureContext("web/src/value.ts")),
    baselineInspection: inspection,
    targetInspection: inspection,
  };
  const result = await inspectManagedCheck("types", context);
  if (!result.applies) throw new Error("Expected compiler targets");
  expect(result.targets.map((t) => t.relativeRoot)).toContain("sibling");
});

it.each(["web/types.d.ts", "package-lock.json", "web/tsconfig.json"])(
  "retains compiler coverage for shared or unknown input %s",
  async (path) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { workspaces: ["sibling"] });
    await f.writeJson("sibling/package.json", { name: "sibling" });
    await f.writeJson("sibling/tsconfig.json", {
      compilerOptions: { types: [] },
      include: ["src"],
    });
    await f.write("sibling/src/value.ts", "export const value=1;");
    const inspection = await inspectRepository(f.root);
    const context = {
      ...(await fixtureContext(path)),
      baselineInspection: inspection,
      targetInspection: inspection,
    };
    const result = await inspectManagedCheck("types", context);
    if (!result.applies) throw new Error("Expected compiler targets");
    expect(result.targets.map((t) => t.relativeRoot)).toContain("sibling");
  },
);

it.each(
  [
    [],
    ["README.md"],
    ["api/value.py"],
    ["api/value.py", "README.md"],
    ["README.md", "web/src/value.ts"],
  ].map((extra) => ({ extra })),
)(
  "keeps independent compiler selection for mixed changes $extra",
  async ({ extra }) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { workspaces: ["web", "sibling"] });
    for (const name of ["web", "sibling"]) {
      await f.writeJson(`${name}/package.json`, { name });
      await f.writeJson(`${name}/tsconfig.json`, {
        compilerOptions: { types: [] },
        include: ["src"],
      });
      await f.write(`${name}/src/value.ts`, "export const value=1;");
    }
    const inspection = await inspectRepository(f.root);
    const context = {
      ...(await fixtureContext("web/src/value.ts")),
      baselineInspection: inspection,
      targetInspection: inspection,
    };
    const paths = [...extra, "web/src/value.ts"];
    context.changeSet = {
      ...context.changeSet,
      files: new Map(
        paths.map((path) => [
          path,
          { path, status: "modified" as const, addedRanges: [] },
        ]),
      ),
    };
    for (const check of ["types", "lint"] as const) {
      const result = await inspectManagedCheck(check, context);
      if (!result.applies) throw Error("Missing web analysis");
      expect(result.targets.map((t) => t.relativeRoot)).toEqual(["web"]);
    }
  },
);

it.each([
  "compiler.md",
  "compiler.py",
  "package-lock.json",
  "web/types.d.ts",
  "values.json",
  "unknown.file",
])(
  "does not narrow when a later mixed input is relevant: %s",
  async (extra) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { workspaces: ["web", "sibling"] });
    for (const name of ["web", "sibling"]) {
      await f.writeJson(`${name}/package.json`, { name });
      await f.writeJson(`${name}/tsconfig.json`, {
        extends: "../compiler.md",
        compilerOptions: { types: [] },
        include: ["src"],
      });
      await f.write(`${name}/src/value.ts`, "export const value=1;");
    }
    await f.writeJson("compiler.md", { extends: "./compiler.py" });
    await f.writeJson("compiler.py", {});
    const inspection = await inspectRepository(f.root);
    const context = {
      ...(await fixtureContext("web/src/value.ts")),
      baselineInspection: inspection,
      targetInspection: inspection,
    };
    context.changeSet = {
      ...context.changeSet,
      files: new Map(
        ["web/src/value.ts", extra].map((path) => [
          path,
          { path, status: "modified" as const, addedRanges: [] },
        ]),
      ),
    };
    const result = await inspectManagedCheck("types", context);
    if (!result.applies) throw Error("Missing analysis");
    expect(result.targets.map((t) => t.relativeRoot)).toContain("sibling");
  },
);

it("shares complete change classification only for identical captured inputs", async () => {
  const { classifyCompilerChanges } =
    await import("../../src/checks/compiler-change-inputs.js");
  const context = await fixtureContext("README.md");
  const first = classifyCompilerChanges(context);
  expect(classifyCompilerChanges({ ...context })).toBe(first);
  expect(await first).toMatchObject({
    complete: true,
    requiresBroadComparison: false,
  });
  const renamed = await fixtureContext("README.md", "types.d.ts");
  expect(
    await classifyCompilerChanges({ ...context, changeSet: renamed.changeSet }),
  ).toMatchObject({ requiresBroadComparison: true });
});
it("bounds metadata discovery before reading oversized compiler configs", async () => {
  const { createCompilerConfigurationInputResolver } =
    await import("../../src/checks/typescript/configuration-paths.js");
  const f = await createInspectionFixture();
  await f.writeJson("package.json", { name: "metadata-budget" });
  await f.write("src/value.ts", "export const value=1;");
  await f.write("tsconfig.json", " ".repeat(64 * 1024) + "{}");
  const inspection = await inspectRepository(f.root);
  expect(
    await createCompilerConfigurationInputResolver(inspection.snapshotRoot)(
      inspection.workspaces[0]!,
    ),
  ).toMatchObject({ complete: false });
});
it("bounds optimization metadata graphs while retaining conservative completeness", async () => {
  const { createCompilerConfigurationInputResolver } =
    await import("../../src/checks/typescript/configuration-paths.js");
  const f = await createInspectionFixture();
  await f.writeJson("package.json", { name: "metadata-count" });
  await f.write("src/value.ts", "export const value=1;");
  const parents = Array.from({ length: 65 }, (_, i) => `./config/${i}.md`);
  await f.writeJson("tsconfig.json", { extends: parents });
  for (const path of parents) await f.writeJson(path, {});
  const inspection = await inspectRepository(f.root);
  expect(
    await createCompilerConfigurationInputResolver(inspection.snapshotRoot)(
      inspection.workspaces[0]!,
    ),
  ).toMatchObject({ complete: false });
});
it("recognizes an explicitly selected Swarm policy even with an ordinary documentation extension", async () => {
  const context = await fixtureContext("policy.md");
  context.config = resolveConfig(
    { schemaVersion: 1 },
    context.repositoryRoot + "/policy.md",
  );
  const { classifyCompilerChanges } =
    await import("../../src/checks/compiler-change-inputs.js");
  expect(await classifyCompilerChanges(context)).toMatchObject({
    complete: true,
    requiresBroadComparison: true,
  });
  expect(await inspectManagedCheck("types", context)).toMatchObject({
    applies: true,
  });
});

it.each(["yaml", "yml"])(
  "treats a modified regular OpenAPI %s document as ordinary",
  async (extension) => {
    const path = `docs/openapi.${extension}`;
    const docs = await fixtureContext(path, undefined, "openapi: 3.1.0\n");
    for (const check of ["types", "lint"] as const)
      expect(await inspectManagedCheck(check, docs)).toMatchObject({
        applies: false,
      });
    expect((await classifyCompilerChanges(docs)).unclassifiedPaths.size).toBe(
      0,
    );

    const source = "src/index.ts";
    const files = new Map(docs.changeSet.files);
    files.set(source, { path: source, status: "modified", addedRanges: [] });
    const mixed = { ...docs, changeSet: { ...docs.changeSet, files } };
    expect(await inspectManagedCheck("types", mixed)).toMatchObject({
      applies: true,
    });
    const classification = await classifyCompilerChanges(mixed);
    expect([...classification.sourcePaths]).toEqual([source]);
    expect(classification.unclassifiedPaths.size).toBe(0);
  },
);

it.each([
  "added",
  "deleted",
  "mode",
  "symlink",
  "aliased",
  "configuration",
] as const)("keeps OpenAPI edits relevant for a %s input", async (kind) => {
  if (
    process.platform === "win32" &&
    ["mode", "symlink", "aliased"].includes(kind)
  )
    return;
  const path = "docs/openapi.yaml";
  const context = await fixtureContext(path);
  const [base, target] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const snapshot of [base, target]) {
    await snapshot.writeJson("package.json", { name: "fixture" });
    await snapshot.write("src/index.ts", "export const value = 1;\n");
    await snapshot.writeJson("tsconfig.json", {
      include: ["src"],
      ...(kind === "configuration" ? { extends: "./docs/openapi.yaml" } : {}),
    });
    await snapshot.write("docs/other.yaml", "openapi: 3.1.0\n");
  }
  if (kind !== "added") await base.write(path, "{}\n");
  if (kind === "symlink") {
    await symlink("other.yaml", join(target.root, path));
  } else if (kind !== "deleted") {
    await target.write(path, '{ "compilerOptions": { "strict": true } }\n');
  }
  if (kind === "mode") await chmod(join(target.root, path), 0o755);
  if (kind === "aliased") {
    for (const snapshot of [base, target])
      await symlink(
        "../docs/openapi.yaml",
        join(snapshot.root, "src/input.ts"),
      );
  }
  const baselineInspection = await inspectRepository(base.root);
  const targetInspection = await inspectRepository(target.root);
  const changed = {
    ...context,
    baselineInspection,
    targetInspection,
    changeSet: {
      ...context.changeSet,
      files: new Map<string, ChangedFile>([
        [
          path,
          {
            path,
            status: kind === "added" || kind === "deleted" ? kind : "modified",
            addedRanges: [],
          },
        ],
      ]),
    },
  };
  expect(
    await compilerInputRelevance(changed, targetInspection.workspaces[0]!),
  ).toMatchObject({
    relevant: true,
    reason: kind === "configuration" ? "configuration" : "unknown",
  });
  const classification = await classifyCompilerChanges(changed);
  if (kind === "configuration") {
    expect(classification.requiresBroadComparison).toBe(true);
  } else {
    expect(classification.unclassifiedPaths.has(path)).toBe(true);
  }
});
