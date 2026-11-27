import { expect, it, vi } from "vitest";
import { loadCompilerScopeInputs } from "../../../src/checks/typescript/compiler-scope-inputs.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import * as contained from "../../../src/inspection/read-json.js";

async function fixture() {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", { workspaces: ["extension"] });
  await f.writeJson("extension/package.json", { name: "extension" });
  await f.writeJson("extension/tsconfig.json", {
    extends: "../base.md",
    compilerOptions: {
      jsx: "react-jsx",
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
      types: ["chrome", "vite/client"],
    },
    include: ["src"],
    references: [{ path: "./tsconfig.node.json" }],
  });
  await f.write(
    "base.md",
    '{ // relative JSONC config\n "compilerOptions": {"strict":true}, }',
  );
  await f.writeJson("extension/tsconfig.node.json", {
    compilerOptions: { types: [] },
    include: ["tools"],
  });
  await f.write("extension/src/popup.tsx", "export const Popup=()=> <div />;");
  await f.write("extension/src/env.d.ts", "declare const version: string;");
  await f.write("extension/tools/build.ts", "export const build=1;");
  await f.write("extension/lint-only.ts", "export const extra=1;");
  const inspection = await inspectRepository(f.root);
  return {
    f,
    inspection,
    workspace: inspection.workspaces.find(
      (w) => w.relativeRoot === "extension",
    )!,
  };
}
it("loads relative configs, local aliases, references and union of lint/type sources without programs", async () => {
  const { inspection, workspace } = await fixture();
  const result = await loadCompilerScopeInputs(inspection, workspace);
  expect(result.complete).toBe(true);
  if (!result.complete) return;
  expect(result.projects.map((p) => p.configPath)).toEqual(
    expect.arrayContaining([
      "extension/tsconfig.json",
      "extension/tsconfig.node.json",
    ]),
  );
  expect([...result.inputPaths]).toEqual(
    expect.arrayContaining([
      "base.md",
      "extension/lint-only.ts",
      "extension/src/env.d.ts",
    ]),
  );
  const main = result.projects.find(
    (p) => p.configPath === "extension/tsconfig.json",
  )!;
  expect(main.options.strict).toBe(true);
  expect(main.options.paths).toEqual({ "@/*": ["src/*"] });
  expect(main.rootPaths).toContain("extension/src/popup.tsx");
  expect(main.rootPaths).not.toContain("extension/lint-only.ts");
  expect(main.sourcePaths).toContain("extension/lint-only.ts");
});
it.each(["cycle", "outside", "package", "broken", "missing"] as const)(
  "falls back for %s configuration",
  async (kind) => {
    const { f, inspection, workspace } = await fixture();
    await f.writeJson("extension/tsconfig.json", {
      extends:
        kind === "cycle"
          ? "./tsconfig.json"
          : kind === "outside"
            ? "../../outside"
            : kind === "package"
              ? "untrusted-config"
              : "./absent",
    });
    if (kind === "broken") await f.write("extension/tsconfig.json", "{broken");
    expect(
      (await loadCompilerScopeInputs(inspection, workspace)).complete,
    ).toBe(false);
  },
);
it("checks cancellation before start and after each bounded read", async () => {
  const { inspection, workspace } = await fixture();
  const before = new AbortController();
  before.abort();
  await expect(
    loadCompilerScopeInputs(inspection, workspace, before.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  const during = new AbortController();
  const original = contained.readContainedFile;
  const spy = vi
    .spyOn(contained, "readContainedFile")
    .mockImplementation(async (...args) => {
      const text = await original(...args);
      during.abort();
      return text;
    });
  try {
    await expect(
      loadCompilerScopeInputs(inspection, workspace, during.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    spy.mockRestore();
  }
});
it.each([
  "source",
  "config",
  "sources",
  "configs",
  "projects",
  "total",
] as const)("enforces %s limits before unbounded reads", async (kind) => {
  const { f, inspection, workspace } = await fixture();
  let selected = workspace;
  if (kind === "source")
    await f.write("extension/src/popup.tsx", "x".repeat(1024 * 1024 + 1));
  if (kind === "config")
    await f.write("extension/tsconfig.json", " ".repeat(64 * 1024 + 1));
  if (kind === "sources")
    selected = {
      ...workspace,
      sourceFiles: Array.from({ length: 501 }, (_, i) => `extension/${i}.ts`),
    };
  if (kind === "configs")
    selected = {
      ...workspace,
      tsconfigPaths: Array.from(
        { length: 65 },
        (_, i) => `extension/tsconfig.${i}.json`,
      ),
    };
  if (kind === "projects") {
    for (let i = 0; i < 33; i++)
      await f.writeJson(`extension/tsconfig.${i}.json`, { include: ["src"] });
    selected = {
      ...workspace,
      tsconfigPaths: Array.from(
        { length: 33 },
        (_, i) => `extension/tsconfig.${i}.json`,
      ),
    };
  }
  if (kind === "total") {
    const paths = [];
    for (let i = 0; i < 9; i++) {
      const path = `extension/src/large${i}.ts`;
      paths.push(path);
      await f.write(path, " ".repeat(510 * 1024));
    }
    selected = {
      ...workspace,
      sourceFiles: [...workspace.sourceFiles, ...paths],
    };
  }
  const read = vi.spyOn(contained, "readContainedFile");
  try {
    expect(await loadCompilerScopeInputs(inspection, selected)).toMatchObject({
      complete: false,
      reason: "limit",
    });
    for (const [, , options] of read.mock.calls)
      expect(options?.maxBytes).toBeLessThanOrEqual(1024 * 1024);
  } finally {
    read.mockRestore();
  }
});
it("keeps e2e include/exclude and source deletions honest", async () => {
  const { f, inspection, workspace } = await fixture();
  await f.writeJson("extension/tsconfig.json", {
    compilerOptions: { baseUrl: ".", paths: { "@fixtures/*": ["tools/*"] } },
    include: ["**/*.ts"],
    exclude: ["src"],
  });
  const result = await loadCompilerScopeInputs(inspection, workspace);
  expect(result.complete).toBe(true);
  if (result.complete)
    expect(result.projects[0]!.rootPaths).not.toContain(
      "extension/src/env.d.ts",
    );
  const { rm } = await import("node:fs/promises");
  await rm(`${f.root}/extension/src/popup.tsx`);
  expect((await loadCompilerScopeInputs(inspection, workspace)).complete).toBe(
    false,
  );
});
it.each(["alias", "outside"] as const)(
  "does not optimize %s config links",
  async (kind) => {
    const { f, inspection, workspace } = await fixture();
    const { symlink, rm } = await import("node:fs/promises");
    await rm(`${f.root}/extension/tsconfig.json`);
    await symlink(
      kind === "alias" ? "../base.md" : "/private/tmp/not-a-snapshot-config",
      `${f.root}/extension/tsconfig.json`,
    );
    expect(
      (await loadCompilerScopeInputs(inspection, workspace)).complete,
    ).toBe(false);
  },
);
it("does not reuse cancelled change classifications or another owner", async () => {
  const { classifyCompilerChanges } =
    await import("../../../src/checks/compiler-change-inputs.js");
  const { inspection, f } = await fixture();
  const first = new AbortController(),
    second = new AbortController();
  const context = {
    repositoryRoot: f.root,
    baselineInspection: inspection,
    targetInspection: inspection,
    signal: first.signal,
    config: (await import("../../../src/config/profiles.js")).resolveConfig({
      schemaVersion: 1,
    }),
    changeSet: {
      files: new Map(),
      isEmpty: true,
      containsAddedLine: () => false,
    },
  };
  const pending = classifyCompilerChanges(context);
  expect(
    classifyCompilerChanges({ ...context, signal: second.signal }),
  ).not.toBe(pending);
  await pending;
  first.abort();
  await expect(classifyCompilerChanges(context)).rejects.toMatchObject({
    name: "AbortError",
  });
});
it("does not declare external referenced roots covered by a workspace-only source inventory", async () => {
  const { f, workspace } = await fixture();
  await f.writeJson("package.json", { workspaces: ["extension", "web"] });
  await f.writeJson("web/package.json", { name: "web" });
  await f.writeJson("web/tsconfig.json", {
    compilerOptions: { types: [] },
    include: ["src"],
  });
  await f.write("web/src/shared.ts", "export const shared=1;");
  await f.writeJson("extension/tsconfig.json", {
    compilerOptions: { types: [] },
    include: ["src"],
    references: [{ path: "../web/tsconfig.json" }],
  });
  const inspection = await inspectRepository(f.root);
  expect((await loadCompilerScopeInputs(inspection, workspace)).complete).toBe(
    false,
  );
});

it("uses the file for an extensionless extends and the directory for a reference with the same name", async () => {
  const { f } = await fixture();
  await f.writeJson("extension/lib.json", {
    compilerOptions: { strict: true },
  });
  await f.write("extension/lib/child.ts", "export const child = true;");
  await f.writeJson("extension/lib/tsconfig.json", { files: ["child.ts"] });
  await f.writeJson("extension/tsconfig.json", {
    extends: "./lib",
    references: [{ path: "./lib" }],
    include: ["src"],
  });
  const inspection = await inspectRepository(f.root);
  const workspace = inspection.workspaces.find(
    (w) => w.relativeRoot === "extension",
  )!;
  // Limit discovery to the selected root so the reference must find its own child.
  const inputs = await loadCompilerScopeInputs(inspection, {
    ...workspace,
    tsconfigPaths: ["extension/tsconfig.json"],
  });
  expect(inputs.complete).toBe(true);
  if (!inputs.complete) throw new Error("Expected complete scope");
  expect(inputs.inputPaths).toContain("extension/lib.json");
  expect(
    inputs.projects.find(
      (project) => project.configPath === "extension/tsconfig.json",
    )?.options.strict,
  ).toBe(true);
  expect(
    inputs.projects.find(
      (project) => project.configPath === "extension/lib/tsconfig.json",
    )?.rootPaths,
  ).toContain("extension/lib/child.ts");
});
