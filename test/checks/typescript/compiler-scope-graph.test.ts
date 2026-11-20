import { expect, it } from "vitest";
import {
  proveCompilerWorkspaceIndependence,
  validateCompilerScopeProofs,
  releaseCompilerScopeProofs,
} from "../../../src/checks/typescript/compiler-scope-graph.js";
import { inspectManagedCheck } from "../../../src/checks/applicability.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import type { InspectionContext } from "../../../src/checks/adapter.js";

async function fixture(source = 'export {value} from "@/local";') {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", { workspaces: ["web", "extension"] });
  for (const name of ["web", "extension"]) {
    await f.writeJson(`${name}/package.json`, { name });
    await f.writeJson(`${name}/tsconfig.json`, {
      compilerOptions: {
        types: [],
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "preserve",
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
      },
      include: ["src"],
      references: [{ path: "./tsconfig.tools.json" }],
    });
    await f.writeJson(`${name}/tsconfig.tools.json`, {
      compilerOptions: { types: [] },
      include: ["tools"],
    });
    await f.write(`${name}/src/local.ts`, "export const value=1;");
    await f.write(
      `${name}/src/popup.tsx`,
      name === "extension" ? source : "export const Popup=()=> <div/>;",
    );
    await f.write(`${name}/tools/build.ts`, "export const build=1;");
  }
  const inspection = await inspectRepository(f.root);
  const signal = new AbortController().signal;
  const context: InspectionContext = {
    repositoryRoot: f.root,
    baselineInspection: inspection,
    targetInspection: inspection,
    signal,
    config: resolveConfig({ schemaVersion: 1 }),
    changeSet: {
      isEmpty: false,
      files: new Map(
        ["web/src/popup.tsx", "README.md", "api/app.py"].map((path) => [
          path,
          { path, status: "modified" as const, addedRanges: [] },
        ]),
      ),
      containsAddedLine: () => false,
    },
  };
  return {
    f,
    context,
    workspace: inspection.workspaces.find(
      (w) => w.relativeRoot === "extension",
    )!,
  };
}
it("proves unchanged local aliases/imports/references independent and actually omits lint/type targets", async () => {
  const { context, workspace } = await fixture();
  expect(await proveCompilerWorkspaceIndependence(context, workspace)).toEqual({
    independent: true,
    reason: "disjoint-inputs",
  });
  for (const check of ["lint", "types"] as const) {
    const result = await inspectManagedCheck(check, context);
    if (!result.applies) throw Error("Web was skipped");
    expect(result.targets.map((t) => t.relativeRoot)).toEqual(["web"]);
  }
  await validateCompilerScopeProofs(context);
  releaseCompilerScopeProofs(context);
});
it.each([
  'import "../../web/src/local"; export {};',
  'export {value} from "../../web/src/local";',
  'export type Value=import("../../web/src/local").Value;',
  'export const f=()=>import("../../web/src/local");',
  'export const f=()=>require("../../web/src/local");',
  '/// <reference path="../../web/src/local.ts" />\nexport {};',
  "export const f=(path:string)=>import(path);",
  "export const f=(path:string)=>require(path);",
  'const require=(name:string)=>name; export const f=require("./local");',
])("retains dependent or unknown workspace: %s", async (source) => {
  const { context, workspace } = await fixture(source);
  expect(
    (await proveCompilerWorkspaceIndependence(context, workspace)).independent,
  ).toBe(false);
  const result = await inspectManagedCheck("types", context);
  if (!result.applies) throw Error("Missing analysis");
  expect(result.targets.map((t) => t.relativeRoot)).toContain("extension");
});
it("follows installed declarations and revalidates their bytes even with restored timestamps", async () => {
  const { f, context, workspace } = await fixture(
    'export {value} from "fixture-package";',
  );
  await f.writeJson("extension/node_modules/fixture-package/package.json", {
    name: "fixture-package",
    types: "index.d.ts",
  });
  await f.write(
    "extension/node_modules/fixture-package/index.d.ts",
    "export declare const value: number;",
  );
  expect(
    (await proveCompilerWorkspaceIndependence(context, workspace)).independent,
  ).toBe(true);
  const { stat, utimes } = await import("node:fs/promises");
  const file = `${f.root}/extension/node_modules/fixture-package/index.d.ts`,
    before = await stat(file);
  await f.write(
    "extension/node_modules/fixture-package/index.d.ts",
    'export {value} from "../../../web/src/local";',
  );
  await utimes(file, before.atime, before.mtime);
  await expect(validateCompilerScopeProofs(context)).rejects.toMatchObject({
    code: "COMPARISON_INPUTS_CHANGED",
  });
  expect(
    (await proveCompilerWorkspaceIndependence(context, workspace)).independent,
  ).toBe(false);
  await expect(validateCompilerScopeProofs(context)).rejects.toMatchObject({
    code: "COMPARISON_INPUTS_CHANGED",
  });
  releaseCompilerScopeProofs(context);
});
it("invalidates a proof when a previously absent baseUrl candidate appears", async () => {
  const { f, context, workspace } = await fixture(
    'export {value} from "fixture-package";',
  );
  await f.writeJson("extension/node_modules/fixture-package/package.json", {
    name: "fixture-package",
    types: "index.d.ts",
  });
  await f.write(
    "extension/node_modules/fixture-package/index.d.ts",
    "export declare const value:number;",
  );
  expect(
    (await proveCompilerWorkspaceIndependence(context, workspace)).independent,
  ).toBe(true);
  await f.writeJson("extension/fixture-package/package.json", {
    types: "../../web/src/local.ts",
  });
  await expect(validateCompilerScopeProofs(context)).rejects.toMatchObject({
    code: "COMPARISON_INPUTS_CHANGED",
  });
});
it.each([
  "automatic",
  "explicit",
  "link",
  "alias-reconnect",
  "missing",
] as const)("keeps %s installed/type boundaries conservative", async (kind) => {
  const { f, context, workspace } = await fixture(
    kind === "alias-reconnect"
      ? 'export {value} from "fixture-package";'
      : "export const local=1;",
  );
  if (kind === "automatic" || kind === "explicit") {
    await f.writeJson("extension/tsconfig.json", {
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        ...(kind === "explicit" ? { types: ["fixture-types"] } : {}),
      },
      include: ["src"],
    });
    await f.writeJson(
      "extension/node_modules/@types/fixture-types/package.json",
      { name: "@types/fixture-types", types: "index.d.ts" },
    );
    await f.write(
      "extension/node_modules/@types/fixture-types/index.d.ts",
      'export {value} from "../../../../web/src/local";',
    );
  }
  if (kind === "alias-reconnect") {
    await f.writeJson("extension/node_modules/fixture-package/package.json", {
      name: "fixture-package",
      types: "index.d.ts",
    });
    await f.write(
      "extension/node_modules/fixture-package/index.d.ts",
      'export {value} from "cross/local";',
    );
    await f.writeJson("extension/tsconfig.json", {
      compilerOptions: {
        types: [],
        baseUrl: ".",
        paths: { "cross/*": ["../web/src/*"] },
        moduleResolution: "Bundler",
        module: "ESNext",
      },
      include: ["src"],
    });
  }
  if (kind === "link") {
    const { mkdir, symlink } = await import("node:fs/promises");
    await mkdir(`${f.root}/extension/node_modules`, { recursive: true });
    await symlink(
      "../../web",
      `${f.root}/extension/node_modules/fixture-package`,
    );
    await f.write(
      "extension/src/popup.tsx",
      'export {value} from "fixture-package";',
    );
  }
  if (kind === "missing") {
    await f.writeJson("extension/package.json", {
      name: "extension",
      devDependencies: { "@types/node": "1.0.0" },
    });
  }
  const inspection = await inspectRepository(f.root);
  const next = {
    ...context,
    baselineInspection: inspection,
    targetInspection: inspection,
  };
  expect(
    (
      await proveCompilerWorkspaceIndependence(
        next,
        inspection.workspaces.find((w) => w.relativeRoot === "extension")!,
      )
    ).independent,
  ).toBe(false);
});
it("rejects changed source/declarations/renames, forced and merge comparisons", async () => {
  const { context, workspace } = await fixture();
  for (const next of [
    { ...context, mergeComparison: true },
    {
      ...context,
      config: resolveConfig({
        schemaVersion: 1,
        checks: { types: { when: "always" } },
      }),
    },
    {
      ...context,
      changeSet: {
        ...context.changeSet,
        files: new Map([
          [
            "README.md",
            {
              path: "README.md",
              previousPath: "extension/src/local.ts",
              status: "renamed" as const,
              addedRanges: [],
            },
          ],
        ]),
      },
    },
    {
      ...context,
      changeSet: {
        ...context.changeSet,
        files: new Map([
          [
            "web/types.d.ts",
            {
              path: "web/types.d.ts",
              status: "deleted" as const,
              addedRanges: [],
            },
          ],
        ]),
      },
    },
  ])
    expect(
      (await proveCompilerWorkspaceIndependence(next, workspace)).independent,
    ).toBe(false);
});
it("checks cancellation while waiting for bounded proof acquisition", async () => {
  const { context, workspace } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    proveCompilerWorkspaceIndependence(
      { ...context, signal: controller.signal },
      workspace,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});
it("bounds graph edges before resolution and validates differing snapshot inputs", async () => {
  const { f, context, workspace } = await fixture(
    'import "./local";\n'.repeat(4097) + "export {};",
  );
  expect(
    await proveCompilerWorkspaceIndependence(context, workspace),
  ).toMatchObject({ independent: false, reason: "limit" });
  await f.write("extension/src/popup.tsx", "export const value=1;");
  const { f: other } = await fixture();
  const baseline = await inspectRepository(other.root);
  expect(
    (
      await proveCompilerWorkspaceIndependence(
        { ...context, baselineInspection: baseline },
        workspace,
      )
    ).independent,
  ).toBe(false);
});
it("actual index scans skip independent targets, preserve new errors and match broad results", async () => {
  const { createGitRepository } =
    await import("../../helpers/git-repository.js");
  const { runScan } = await import("../../../src/scan/run-scan.js");
  const repo = await createGitRepository();
  const checks = {
    lint: "error",
    types: "error",
    formatting: "off",
    secrets: "off",
    cyclomaticComplexity: "off",
    readabilityComplexity: "off",
    structuralSecurity: "off",
    duplication: "off",
    dependencyArchitecture: "off",
    deadCode: "off",
    reactCorrectness: "off",
    reactAccessibility: "off",
    vulnerabilities: "off",
  };
  await repo.write(
    "package.json",
    JSON.stringify({ name: "root", workspaces: ["web", "extension"] }),
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({ schemaVersion: 1, checks }),
  );
  for (const name of ["web", "extension"]) {
    await repo.write(`${name}/package.json`, JSON.stringify({ name }));
    await repo.write(
      `${name}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: {
          types: [],
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
        },
        include: ["src"],
      }),
    );
    await repo.write(`${name}/src/local.ts`, "export const value=1;");
    await repo.write(`${name}/src/index.ts`, 'export {value} from "./local";');
  }
  await repo.commitAll("baseline");
  await repo.write("web/src/local.ts", "export const value:string=1;");
  await repo.write("README.md", "unrelated documentation");
  await repo.git(["add", "web/src/local.ts", "README.md"]);
  // Unstaged repair must not hide the staged type error.
  await repo.write("web/src/local.ts", 'export const value:string="ok";');
  const selected = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(selected.outcome).toBe("blocked");
  expect(
    selected.checks.filter(
      (c) => ["lint", "types"].includes(c.checkId) && c.target === "extension",
    ),
  ).toHaveLength(0);
  expect(
    selected.summary.findings.some((f) => f.rule === "typescript/TS2322"),
  ).toBe(true);
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      checks: {
        ...checks,
        lint: { severity: "error", when: "always" },
        types: { severity: "error", when: "always" },
      },
    }),
  );
  await repo.git(["add", ".zedbeerc.jsonc"]);
  const broad = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(
    broad.checks.some((c) => c.target === "extension" && c.checkId === "types"),
  ).toBe(true);
  const canonical = (report: typeof broad) =>
    report.summary.findings.map(
      ({ check, rule, severity, message, location, attribution }) => ({
        check,
        rule,
        severity,
        message,
        location,
        attribution,
      }),
    );
  expect(canonical(selected)).toEqual(canonical(broad));
  expect(broad.outcome).toBe(selected.outcome);
});
it("retains conditional require exports that reconnect to repository source", async () => {
  const { f, context, workspace } = await fixture(
    'export const load=()=>require("fixture-package");',
  );
  await f.writeJson("extension/node_modules/fixture-package/package.json", {
    name: "fixture-package",
    exports: {
      ".": {
        import: { types: "./safe.d.ts" },
        require: { types: "./cross.d.ts" },
      },
    },
  });
  await f.write(
    "extension/node_modules/fixture-package/safe.d.ts",
    "export declare const value: number;",
  );
  await f.write(
    "extension/node_modules/fixture-package/cross.d.ts",
    'export {value} from "cross/local";',
  );
  await f.writeJson("extension/tsconfig.json", {
    compilerOptions: {
      types: [],
      baseUrl: ".",
      paths: { "cross/*": ["../web/src/*"] },
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["src"],
  });
  expect(
    (await proveCompilerWorkspaceIndependence(context, workspace)).independent,
  ).toBe(false);
});
it("does not omit a module augmentation edge", async () => {
  const { context, workspace } = await fixture(
    'declare module "../../web/src/local" { export const extra: number; } export {};',
  );
  expect(
    (await proveCompilerWorkspaceIndependence(context, workspace)).independent,
  ).toBe(false);
});
it("keeps proof owners separate when callers reuse one AbortSignal", async () => {
  const first = await fixture();
  const second = await fixture();
  const secondContext = { ...second.context, signal: first.context.signal! };
  expect(
    (await proveCompilerWorkspaceIndependence(first.context, first.workspace))
      .independent,
  ).toBe(true);
  expect(
    (await proveCompilerWorkspaceIndependence(secondContext, second.workspace))
      .independent,
  ).toBe(true);
  releaseCompilerScopeProofs(first.context);
  await second.f.write("extension/src/local.ts", "export const value=2;");
  await expect(
    validateCompilerScopeProofs(secondContext),
  ).rejects.toMatchObject({ code: "COMPARISON_INPUTS_CHANGED" });
});
it("follows builtin ambient types and standard library references without assuming an inert package", async () => {
  const { f, context, workspace } = await fixture(
    'import type {PathLike} from "node:fs"; export type Path=PathLike;',
  );
  await f.writeJson("extension/node_modules/@types/node/package.json", {
    name: "@types/node",
    types: "index.d.ts",
  });
  await f.write(
    "extension/node_modules/@types/node/index.d.ts",
    '/// <reference lib="es2020" />\ndeclare module "node:fs" { export type PathLike=string; }',
  );
  expect(
    (await proveCompilerWorkspaceIndependence(context, workspace)).independent,
  ).toBe(true);
  await f.writeJson(
    "extension/node_modules/@typescript/lib-es2020/package.json",
    { name: "@typescript/lib-es2020", types: "index.d.ts" },
  );
  await f.write(
    "extension/node_modules/@typescript/lib-es2020/index.d.ts",
    'export {value} from "cross/local";',
  );
  await expect(validateCompilerScopeProofs(context)).rejects.toMatchObject({
    code: "COMPARISON_INPUTS_CHANGED",
  });
  expect(
    (await proveCompilerWorkspaceIndependence(context, workspace)).independent,
  ).toBe(false);
});
it("retains cross-workspace project references even when no direct import names the changed source", async () => {
  const { f, context, workspace } = await fixture();
  await f.writeJson("extension/tsconfig.json", {
    compilerOptions: {
      types: [],
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["src"],
    references: [{ path: "../web/tsconfig.json" }],
  });
  expect(
    (await proveCompilerWorkspaceIndependence(context, workspace)).independent,
  ).toBe(false);
});
it("keeps per-file JSX runtime pragmas outside the optimization proof", async () => {
  const { f, context, workspace } = await fixture(
    "/** @jsxImportSource custom */\nexport const Popup=()=> <div/>;",
  );
  await f.writeJson("extension/tsconfig.json", {
    compilerOptions: {
      types: [],
      jsx: "react-jsx",
      module: "ESNext",
      moduleResolution: "Bundler",
      baseUrl: ".",
      paths: { "custom/jsx-runtime": ["../web/src/local.ts"] },
    },
    include: ["src"],
  });
  await f.writeJson("extension/node_modules/react/package.json", {
    name: "react",
    types: "index.d.ts",
  });
  await f.write(
    "extension/node_modules/react/jsx-runtime.d.ts",
    "export declare const jsx: unknown;",
  );
  expect(
    (await proveCompilerWorkspaceIndependence(context, workspace)).independent,
  ).toBe(false);
});
it("keeps default library replacements in the proof for import-free NodeNext projects", async () => {
  const { f, context, workspace } = await fixture("export const value=1;");
  await f.writeJson("extension/tsconfig.json", {
    compilerOptions: {
      types: [],
      module: "NodeNext",
      moduleResolution: "NodeNext",
    },
    include: ["src"],
  });
  await f.writeJson("extension/node_modules/@typescript/lib-dom/package.json", {
    name: "@typescript/lib-dom",
    types: "index.d.ts",
  });
  await f.write(
    "extension/node_modules/@typescript/lib-dom/index.d.ts",
    'export {value} from "../../../web/src/local";',
  );
  expect(
    (await proveCompilerWorkspaceIndependence(context, workspace)).independent,
  ).toBe(false);
});
