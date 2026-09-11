import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { createInspectionFixture } from "../../inspection/fixture.js";

import {
  createSnapshotProgram,
  type SnapshotProgramInput,
} from "../../../src/checks/typescript/compiler-host.js";

function project(files: Record<string, string>): SnapshotProgramInput {
  return {
    repositoryRoot: process.cwd(),
    files,
    rootNames: Object.keys(files).filter((file) => file.endsWith(".ts")),
    options: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
  };
}

describe("snapshot-aware TypeScript compiler host", () => {
  it("resolves nested config aliases without baseUrl against snapshot source", () => {
    const snapshotRoot = path.resolve("/virtual/zedbee-snapshot");
    const config = ts.parseJsonConfigFileContent(
      {
        compilerOptions: {
          paths: { "@/*": ["./*"] },
          moduleResolution: "bundler",
          module: "esnext",
        },
      },
      { ...ts.sys, readDirectory: () => [] },
      path.join(snapshotRoot, "web"),
    );
    const result = createSnapshotProgram({
      repositoryRoot: process.cwd(),
      snapshotRoot,
      files: {
        "web/main.ts":
          'import { value } from "@/lib/value"; const answer: string = value;',
        "web/lib/value.ts": "export const value = 42;",
      },
      rootNames: ["web/main.ts"],
      options: { ...config.options, types: [] },
    });
    expect(
      result.program.getSemanticDiagnostics().map((item) => item.code),
    ).toEqual([2322]);
    expect(result.localReads).toContain("web/lib/value.ts");
  });

  it.each(["automatic", "explicit"])(
    "uses nested packages before root packages with %s ambient type roots",
    async (typeRootsMode) => {
      const fixture = await createInspectionFixture();
      await fixture.write(
        "web/node_modules/example/index.d.ts",
        "export const value: number;",
      );
      await fixture.write(
        "node_modules/example/index.d.ts",
        "export const value: string;",
      );
      await fixture.write(
        "web/node_modules/@types/environment/index.d.ts",
        "declare const environment: number;",
      );
      const snapshotRoot = path.join(fixture.root, "snapshot");
      const result = createSnapshotProgram({
        repositoryRoot: fixture.root,
        snapshotRoot,
        files: {
          "web/main.ts":
            'import { value } from "example"; const answer: string = value; const env: number = environment;',
        },
        rootNames: ["web/main.ts"],
        options: {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          configFilePath: path.join(snapshotRoot, "web/tsconfig.json"),
          ...(typeRootsMode === "explicit"
            ? {
                types: ["environment"],
                typeRoots: [path.join(snapshotRoot, "web/node_modules/@types")],
              }
            : {}),
        },
      });
      expect(
        result.program.getSemanticDiagnostics().map((item) => item.code),
      ).toEqual([2322]);
      expect(result.packageReads).toContain(
        path.join(fixture.root, "web/node_modules/example/index.d.ts"),
      );
    },
  );

  it("does not satisfy aliases with source absent from the snapshot", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("web/lib/value.ts", "export const value = 42;");
    const result = createSnapshotProgram({
      repositoryRoot: fixture.root,
      snapshotRoot: path.join(fixture.root, "snapshot"),
      files: {
        "web/main.ts": 'import { value } from "@/lib/value"; export { value };',
      },
      rootNames: ["web/main.ts"],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        types: [],
        baseUrl: path.join(fixture.root, "web"),
        paths: { "@/*": ["./*"] },
      },
    });
    expect(
      result.program.getSemanticDiagnostics().map((item) => item.code),
    ).toEqual([2307]);
  });

  it("reads local project source only from the immutable snapshot", () => {
    const result = createSnapshotProgram(
      project({
        "src/main.ts":
          'import { value } from "./value.js"; const answer: string = value;',
        "src/value.ts": "export const value = 42;",
      }),
    );

    expect(
      result.program
        .getSemanticDiagnostics()
        .some((diagnostic) => diagnostic.code === 2322),
    ).toBe(true);
    expect(result.localReads).toContain("src/value.ts");
  });

  it("forces noEmit and never writes generated output", () => {
    const outputDirectory = path.join(
      process.cwd(),
      ".zedbee-typescript-output",
    );
    const result = createSnapshotProgram(
      project({ "src/main.ts": "export const value: number = 1;" }),
    );

    expect(result.program.getCompilerOptions()).toMatchObject({
      noEmit: true,
      incremental: false,
      composite: false,
    });
    result.program.emit();
    expect(result.writes).toEqual([]);
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("resolves node:fs and installed package declarations through the safe package boundary", () => {
    const result = createSnapshotProgram(
      project({
        "src/main.ts": [
          'import type { Stats } from "node:fs";',
          'import type { Linter } from "eslint";',
          "export type Result = Stats | Linter.Config;",
        ].join("\n"),
      }),
    );

    expect(result.program.getSemanticDiagnostics()).toEqual([]);
    expect(
      result.packageReads.some((file) => file.includes("node_modules")),
    ).toBe(true);
  });
});
