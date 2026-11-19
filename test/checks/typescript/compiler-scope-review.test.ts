import { expect, it, vi } from "vitest";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import { proveCompilerWorkspaceIndependence } from "../../../src/checks/typescript/compiler-scope-graph.js";
import { loadSnapshotProjectSet } from "../../../src/checks/typescript/projects.js";
import { CapturedDependencies } from "../../../src/cache/captured-dependencies.js";
import { assertRequiredInstallation } from "../../../src/checks/comparison-context.js";
import type { InspectionContext } from "../../../src/checks/adapter.js";
import * as scopeInputs from "../../../src/checks/typescript/compiler-scope-inputs.js";
import { classifyCompilerChanges } from "../../../src/checks/compiler-change-inputs.js";
import { createCompilerConfigurationInputResolver } from "../../../src/checks/typescript/configuration-paths.js";

async function comparison(kind: string) {
  const makeFixture = async () => {
    const f = await createInspectionFixture();
    return { ...f, root: await realpath(f.root) };
  };
  const [live, before, after] = await Promise.all([
    makeFixture(),
    makeFixture(),
    makeFixture(),
  ]);
  for (const [index, f] of [live, before, after].entries()) {
    await f.writeJson("package.json", { workspaces: ["extension", "web"] });
    for (const name of ["extension", "web"])
      await f.writeJson(`${name}/package.json`, { name });
    const options: Record<string, unknown> = {
      types: [],
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["es5"],
      baseUrl: ".",
      paths: { cross: ["../web/shared"] },
    };
    const paths = options.paths as Record<string, string[]>;
    let source = "export const value: Shared = 1;";
    let shared = `declare global {type Shared=${index === 2 ? "string" : "number"};} export {};`;
    if (kind === "jsdoc") {
      options.allowJs = true;
      source =
        'import {value} from "./bridge.js"; export const n:number=value;';
      await f.write(
        "extension/bridge.js",
        '/** @type {import("cross").T} */ export const value=/** @type {any} */ (0);',
      );
      shared = `export type T=${index === 2 ? "string" : "number"};`;
    } else if (kind === "helpers") {
      options.importHelpers = true;
      paths.tslib = ["../web/shared"];
    } else if (kind === "jsx") {
      options.jsx = "react-jsx";
      paths["react/jsx-runtime"] = ["../web/shared"];
    } else if (kind === "builtin") {
      paths.fs = ["../web/shared"];
      source = 'import {v} from "fs"; export const n:number=v;';
      shared = `export const v=${index === 2 ? '"s"' : "3"};`;
    } else if (kind === "manifest") {
      source = 'import {v} from "./impl"; export const n:number=v;';
      shared = `export const v=${index === 2 ? '"s"' : "3"};`;
      await f.write("extension/impl/index.ts", "export const v=3;");
      await f.writeJson("extension/impl/package.json", {
        types: "../../web/shared.ts",
      });
    } else if (kind === "references") {
      source = 'import "entry"; export const value: Shared=1;';
    }
    await f.writeJson("extension/tsconfig.json", {
      compilerOptions: options,
      include: ["**/*.ts", "*.js"],
    });
    await f.writeJson("web/tsconfig.json", {
      compilerOptions: { types: [], lib: ["es5"] },
      include: ["*.ts"],
    });
    await f.write("extension/main.ts", source);
    await f.write("web/shared.ts", shared);
  }
  if (kind === "builtin") {
    await live.writeJson("extension/node_modules/@types/node/package.json", {
      name: "@types/node",
      types: "index.d.ts",
    });
    await live.write(
      "extension/node_modules/@types/node/index.d.ts",
      "export {};",
    );
  }
  if (kind === "references") {
    await live.writeJson("extension/node_modules/entry/package.json", {
      name: "entry",
      types: "index.d.ts",
    });
    await live.write(
      "extension/node_modules/entry/index.d.ts",
      '/// <reference types="dualmode" resolution-mode="require"/>\nexport {};',
    );
    await live.writeJson("extension/node_modules/dualmode/package.json", {
      name: "dualmode",
      exports: { ".": { import: "./safe.d.ts", require: "./cross.d.ts" } },
    });
    await live.write(
      "extension/node_modules/dualmode/safe.d.ts",
      "declare global {type Shared=number;} export {};",
    );
    await live.write(
      "extension/node_modules/dualmode/cross.d.ts",
      'import "cross";',
    );
  }
  const baselineInspection = await inspectRepository(before.root);
  const targetInspection = await inspectRepository(after.root);
  const workspace = targetInspection.workspaces.find(
    (w) => w.relativeRoot === "extension",
  )!;
  const context: InspectionContext = {
    repositoryRoot: live.root,
    baselineInspection,
    targetInspection,
    config: resolveConfig({ schemaVersion: 1 }),
    signal: new AbortController().signal,
    changeSet: {
      isEmpty: false,
      files: new Map([
        [
          "web/shared.ts",
          { path: "web/shared.ts", status: "modified", addedRanges: [] },
        ],
      ]),
      containsAddedLine: () => false,
    },
  };
  return { live, before, after, workspace, context };
}

it.each(["jsdoc", "helpers", "jsx", "builtin", "manifest", "references"])(
  "retains the broad compiler's new assignment error through %s",
  async (kind) => {
    const { live, before, after, workspace, context } = await comparison(kind);
    const codes = [];
    for (const f of [before, after]) {
      const inspection = await inspectRepository(f.root);
      const project = await loadSnapshotProjectSet(
        f.root,
        live.root,
        inspection.workspaces.find((w) => w.relativeRoot === "extension")!,
      );
      codes.push(
        project.programs
          .flatMap((p) => p.getSemanticDiagnostics())
          .filter((d) => d.file?.fileName.endsWith("/extension/main.ts"))
          .map((d) => d.code),
      );
    }
    expect(codes[0]).not.toContain(2322);
    expect(codes[1]).toContain(2322);
    expect(
      (await proveCompilerWorkspaceIndependence(context, workspace))
        .independent,
    ).toBe(false);
  },
);

it("retains missing dependency declarations inherited from a nested workspace's parent", async () => {
  const { live, before, after, context } = await comparison("ancestor");
  for (const f of [live, before, after]) {
    await f.writeJson("package.json", {
      workspaces: ["group", "group/extension", "web"],
    });
    await f.writeJson("group/package.json", {
      name: "group",
      devDependencies: { "@types/node": "1" },
    });
    await f.writeJson("group/extension/package.json", { name: "nested" });
    await f.writeJson("group/extension/tsconfig.json", {
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["es5"],
      },
      include: ["*.ts"],
    });
    await f.write("group/extension/main.ts", "export const pid=process.pid;");
  }
  const baselineInspection = await inspectRepository(before.root),
    targetInspection = await inspectRepository(after.root);
  const workspace = targetInspection.workspaces.find(
    (w) => w.relativeRoot === "group/extension",
  )!;
  const dependencies = new CapturedDependencies({
    repositoryRoot: live.root,
    snapshots: { baselineDir: before.root, targetDir: after.root },
  });
  const { programs } = await loadSnapshotProjectSet(
    before.root,
    live.root,
    baselineInspection.workspaces.find(
      (w) => w.relativeRoot === "group/extension",
    )!,
    dependencies,
  );
  await expect(
    assertRequiredInstallation({
      programs,
      inspection: baselineInspection,
      workspace,
      repositoryRoot: live.root,
      dependencies,
      side: "baseline",
    }),
  ).rejects.toMatchObject({ code: "COMPARISON_INSTALLATION_UNAVAILABLE" });
  expect(
    (
      await proveCompilerWorkspaceIndependence(
        { ...context, baselineInspection, targetInspection },
        workspace,
      )
    ).independent,
  ).toBe(false);
});

it("does not establish sibling importer readiness with a different workspace's package", async () => {
  const { live, before, context } = await comparison("readiness");
  await before.writeJson("extension/package.json", {
    name: "extension",
    dependencies: { pkg: "1" },
  });
  await before.write(
    "extension/main.ts",
    'import {v} from "pkg"; import {w} from "../web/shared"; export const x=v+w;',
  );
  await before.write(
    "web/shared.ts",
    'import {v} from "pkg"; export const w=v;',
  );
  await live.writeJson("extension/node_modules/pkg/package.json", {
    name: "pkg",
    types: "index.d.ts",
  });
  await live.write(
    "extension/node_modules/pkg/index.d.ts",
    "export declare const v:number;",
  );
  const inspection = await inspectRepository(before.root),
    workspace = inspection.workspaces.find(
      (w) => w.relativeRoot === "extension",
    )!;
  const dependencies = new CapturedDependencies({
    repositoryRoot: live.root,
    snapshots: { baselineDir: before.root, targetDir: before.root },
  });
  const { programs } = await loadSnapshotProjectSet(
    before.root,
    live.root,
    workspace,
    dependencies,
  );
  await expect(
    assertRequiredInstallation({
      programs,
      inspection,
      workspace,
      repositoryRoot: context.repositoryRoot,
      dependencies,
      side: "baseline",
    }),
  ).rejects.toMatchObject({ code: "COMPARISON_INSTALLATION_UNAVAILABLE" });
});

it("charges configured type root resolutions to the graph edge limit", async () => {
  const { live, before, after, context } = await comparison("edges");
  for (const f of [before, after])
    await f.writeJson("extension/tsconfig.json", {
      compilerOptions: {
        types: Array(4097).fill("t"),
        noLib: true,
        moduleResolution: "Bundler",
        module: "ESNext",
      },
      include: ["*.ts"],
    });
  await live.writeJson("extension/node_modules/@types/t/package.json", {
    name: "@types/t",
    types: "index.d.ts",
  });
  await live.write("extension/node_modules/@types/t/index.d.ts", "export {};");
  const baselineInspection = await inspectRepository(before.root),
    targetInspection = await inspectRepository(after.root);
  expect(
    await proveCompilerWorkspaceIndependence(
      { ...context, baselineInspection, targetInspection },
      targetInspection.workspaces.find((w) => w.relativeRoot === "extension")!,
    ),
  ).toMatchObject({ independent: false, reason: "limit" });
});

it("cancels a queued proof before an unrelated active proof finishes", async () => {
  const a = await comparison("queue-a"),
    b = await comparison("queue-b");
  await classifyCompilerChanges(a.context);
  await classifyCompilerChanges(b.context);
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  const original = scopeInputs.loadCompilerScopeInputs;
  const spy = vi
    .spyOn(scopeInputs, "loadCompilerScopeInputs")
    .mockImplementationOnce(async (...args) => {
      entered();
      await hold;
      return original(...args);
    });
  const active = proveCompilerWorkspaceIndependence(a.context, a.workspace);
  await started;
  const controller = new AbortController();
  const pending = proveCompilerWorkspaceIndependence(
    { ...b.context, signal: controller.signal },
    b.workspace,
  ).then(
    () => "finished",
    (e) => (e as Error).name,
  );
  await new Promise((r) => setImmediate(r));
  controller.abort();
  try {
    expect(
      await Promise.race([
        pending,
        new Promise((r) => setTimeout(() => r("still pending"), 100)),
      ]),
    ).toBe("AbortError");
  } finally {
    release();
    await active;
    await pending;
    spy.mockRestore();
  }
});

it("falls back before acquiring metadata for more than 32 workspaces", async () => {
  const { context, workspace } = await comparison("workspace-limit");
  const inspection = {
    ...context.targetInspection,
    workspaces: Array.from({ length: 33 }, (_, i) => ({
      ...workspace,
      relativeRoot: `group-${i}`,
      manifestPath: `group-${i}/package.json`,
    })),
  };
  const result = await classifyCompilerChanges({
    ...context,
    baselineInspection: inspection,
    targetInspection: inspection,
  });
  expect(result).toMatchObject({
    complete: false,
    requiresBroadComparison: true,
  });
});

it("bounds candidate metadata requests before traversing a large extends list", async () => {
  const { before, workspace } = await comparison("metadata-limit");
  await before.writeJson("extension/tsconfig.json", {
    extends: Array.from({ length: 1024 }, (_, i) => `./missing-${i}`),
  });
  const result = await createCompilerConfigurationInputResolver(before.root)(
    workspace,
  );
  expect(result.complete).toBe(false);
  expect(result.paths.size).toBeLessThanOrEqual(193);
});
