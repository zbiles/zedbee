import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { createSnapshotProgram } from "../../../src/checks/typescript/compiler-host.js";

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  strict: true,
  types: [],
  noEmit: true,
};

function diagnostics(program: ts.Program) {
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file && path.basename(diagnostic.file.fileName),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  }));
}

async function comparePrograms(
  files: Record<string, string>,
  rootNames: string[],
  compilerOptions = options,
  packages: Record<string, string> = {},
) {
  const fixture = await createInspectionFixture();
  for (const [file, source] of Object.entries({ ...files, ...packages })) {
    await fixture.write(file, source);
  }
  const native = ts.createProgram(
    rootNames.map((file) => path.join(fixture.root, file)),
    compilerOptions,
  );
  const snapshot = createSnapshotProgram({
    repositoryRoot: fixture.root,
    snapshotRoot: path.join(fixture.root, "snapshot"),
    files,
    rootNames,
    options: compilerOptions,
  });
  return { fixture, native, snapshot };
}

describe("snapshot compiler parity with native TypeScript", () => {
  it("parses JSX imports with the native JavaScript JSX grammar", async () => {
    const { native, snapshot } = await comparePrograms(
      {
        "component.jsx": "export const component = <div/>;",
        "main.ts":
          'import { component } from "./component.jsx"; export { component };',
        "global.d.ts":
          "declare namespace JSX { interface IntrinsicElements { div: {}; } }",
      },
      ["main.ts", "global.d.ts"],
      {
        ...options,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve,
        allowJs: true,
        checkJs: true,
      },
    );
    expect(diagnostics(native)).toEqual([]);
    expect(diagnostics(snapshot.program)).toEqual(diagnostics(native));
    expect(snapshot.localReads).toContain("component.jsx");
  });

  it.each(["js", "mjs", "cjs", "json"])(
    "keeps native parsing and type errors for %s imports",
    async (extension) => {
      const file = `value.${extension}`;
      const { native, snapshot } = await comparePrograms(
        {
          [file]:
            extension === "json" ? '{"value": 42}' : "export const value = 42;",
          "main.ts": `import { value } from "./${file}"; export const answer: string = value;`,
        },
        ["main.ts"],
        {
          ...options,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          allowJs: true,
          checkJs: true,
          resolveJsonModule: true,
        },
      );
      expect(diagnostics(native).map(({ code }) => code)).toEqual([2322]);
      expect(diagnostics(snapshot.program)).toEqual(diagnostics(native));
    },
  );

  it.each([
    ["main.mts", "module", "string"],
    ["main.cts", "commonjs", "number"],
    ["main.ts", "module", "string"],
    ["main.ts", "commonjs", "number"],
  ])(
    "selects conditional exports for %s in a %s package",
    async (file, type, valueType) => {
      const { fixture, native, snapshot } = await comparePrograms(
        {
          "package.json": JSON.stringify({ type }),
          [file!]: `import { value } from "dual"; export const answer: ${valueType} = value;`,
        },
        [file!],
        options,
        {
          "node_modules/dual/package.json": JSON.stringify({
            name: "dual",
            exports: { ".": { import: "./esm.d.mts", require: "./cjs.d.cts" } },
          }),
          "node_modules/dual/esm.d.mts": "export declare const value: string;",
          "node_modules/dual/cjs.d.cts": "export declare const value: number;",
        },
      );
      expect(diagnostics(native)).toEqual([]);
      expect(diagnostics(snapshot.program)).toEqual(diagnostics(native));
      expect(snapshot.packageReads).toContain(
        path.join(
          fixture.root,
          `node_modules/dual/${valueType === "string" ? "esm.d.mts" : "cjs.d.cts"}`,
        ),
      );
    },
  );

  it("resolves import and require usages of the same package independently", async () => {
    const { native, snapshot } = await comparePrograms(
      {
        "main.mts": [
          'import { value } from "dual";',
          'import required = require("dual");',
          'import type { value as requiredValue } from "dual" with { "resolution-mode": "require" };',
          "export const imported: string = value;",
          "export const loaded: number = required.value;",
          "export const explicit: typeof requiredValue = 42;",
        ].join("\n"),
        "dynamic.cts":
          'export async function load() { const { value } = await import("dual"); const answer: string = value; return answer; }',
      },
      ["main.mts", "dynamic.cts"],
      options,
      {
        "node_modules/dual/package.json": JSON.stringify({
          name: "dual",
          exports: { ".": { import: "./esm.d.mts", require: "./cjs.d.cts" } },
        }),
        "node_modules/dual/esm.d.mts": "export declare const value: string;",
        "node_modules/dual/cjs.d.cts": "export declare const value: number;",
      },
    );
    expect(diagnostics(native)).toEqual([]);
    expect(diagnostics(snapshot.program)).toEqual(diagnostics(native));
  });

  it("uses conditional package imports from the captured snapshot", async () => {
    const { native, snapshot } = await comparePrograms(
      {
        "package.json": JSON.stringify({
          imports: { "#value": { import: "./esm.mjs", require: "./cjs.cjs" } },
        }),
        "esm.mts": 'export const value = "esm";',
        "cjs.cts": "export const value = 42;",
        "main.mts":
          'import { value } from "#value"; export const answer: string = value;',
        "main.cts":
          'import value = require("#value"); export const answer: number = value.value;',
      },
      ["main.mts", "main.cts"],
    );
    expect(diagnostics(native)).toEqual([]);
    expect(diagnostics(snapshot.program)).toEqual(diagnostics(native));
    expect(snapshot.localReads).toEqual([
      "cjs.cts",
      "esm.mts",
      "main.cts",
      "main.mts",
    ]);
  });

  it("uses a referenced project's own paths and JSX options", async () => {
    const fixture = await createInspectionFixture();
    const files = {
      "app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          composite: true,
          module: "esnext",
          moduleResolution: "bundler",
          jsx: "preserve",
          types: [],
          paths: { "@value": ["./value.ts"] },
        },
        files: ["main.tsx", "value.ts"],
      }),
      "app/main.tsx":
        'import { value } from "@value"; export const answer: number = value;',
      "app/value.ts": 'export const value = "child";',
      "parent-value.ts": "export const value = 42;",
    };
    for (const [file, source] of Object.entries(files))
      await fixture.write(file, source);
    const config = ts.getParsedCommandLineOfConfigFile(
      path.join(fixture.root, "app/tsconfig.json"),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(
            ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
          );
        },
      },
    )!;
    const native = ts.createProgram(config.fileNames, {
      ...config.options,
      noEmit: true,
      composite: false,
      incremental: false,
    });
    const snapshotRoot = path.join(fixture.root, "snapshot");
    const parentConfig = ts.parseJsonConfigFileContent(
      { compilerOptions: { paths: { "@value": ["./parent-value.ts"] } } },
      { ...ts.sys, readDirectory: () => [] },
      snapshotRoot,
    );
    const snapshot = createSnapshotProgram({
      repositoryRoot: fixture.root,
      snapshotRoot,
      files,
      rootNames: [],
      options: {
        ...options,
        ...parentConfig.options,
      },
      projectReferences: [{ path: path.join(snapshotRoot, "app") }],
    });
    expect(diagnostics(native).map(({ code }) => code)).toEqual([2322]);
    expect(snapshot.programs).toHaveLength(2);
    expect(diagnostics(snapshot.programs[1]!)).toEqual(diagnostics(native));
    expect(snapshot.localReads).toContain("app/value.ts");
    expect(snapshot.localReads).not.toContain("parent-value.ts");
  });

  it.each(["inferred", "explicit", "compiler-default"])(
    "uses a referenced project's own %s installed type roots",
    async (typeRootsMode) => {
      const fixture = await createInspectionFixture();
      await fixture.write(
        "app/node_modules/@types/environment/index.d.ts",
        "declare const environment: string;",
      );
      await fixture.write(
        "node_modules/@types/environment/index.d.ts",
        "declare const environment: number;",
      );
      const files = {
        "app/tsconfig.json": JSON.stringify({
          compilerOptions: {
            composite: true,
            skipLibCheck: true,
            ...(typeRootsMode === "compiler-default"
              ? {}
              : { types: ["environment"] }),
            ...(typeRootsMode === "explicit"
              ? { typeRoots: ["./node_modules/@types"] }
              : {}),
          },
          files: ["main.ts"],
        }),
        "app/main.ts": "export const answer: number = environment;",
      };
      for (const [file, source] of Object.entries(files))
        await fixture.write(file, source);
      const config = ts.getParsedCommandLineOfConfigFile(
        path.join(fixture.root, "app/tsconfig.json"),
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            throw new Error(
              ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
            );
          },
        },
      )!;
      const native = ts.createProgram(config.fileNames, {
        ...config.options,
        noEmit: true,
        composite: false,
        incremental: false,
      });
      const snapshotRoot = path.join(fixture.root, "snapshot");
      const snapshot = createSnapshotProgram({
        repositoryRoot: fixture.root,
        snapshotRoot,
        files,
        rootNames: [],
        options,
        projectReferences: [{ path: path.join(snapshotRoot, "app") }],
      });
      expect(diagnostics(native).map(({ code }) => code)).toEqual([
        typeRootsMode === "compiler-default" ? 2304 : 2322,
      ]);
      expect(diagnostics(snapshot.programs[1]!)).toEqual(diagnostics(native));
      if (typeRootsMode !== "compiler-default")
        expect(snapshot.packageReads).toContain(
          path.join(
            fixture.root,
            "app/node_modules/@types/environment/index.d.ts",
          ),
        );
    },
  );
});
