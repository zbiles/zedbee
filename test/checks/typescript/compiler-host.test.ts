import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

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
