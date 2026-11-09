import { describe, expect, it } from "vitest";
import { inspectManagedCheck } from "../../src/checks/applicability.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import type { ChangedFile } from "../../src/git/change-set.js";

async function fixtureContext(path: string, previousPath?: string) {
  const fixture = await createInspectionFixture();
  await fixture.writeJson("package.json", { name: "synthetic" });
  await fixture.writeJson("tsconfig.json", { include: ["src"] });
  await fixture.write("src/index.ts", "export const value = 1;\n");
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
  ])("keeps conservative compiler coverage for %s", async (path) => {
    const context = await fixtureContext(path);
    for (const check of ["types", "lint"] as const)
      expect(await inspectManagedCheck(check, context)).toMatchObject({
        applies: true,
      });
  });

  it.each([
    ["removed.md", "src/old.ts"],
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
  it.each(["config/compiler.md", "config/compiler.py", "config/compiler.txt"])(
    "does not classify inherited %s as unrelated",
    async (path) => {
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
    },
  );

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
