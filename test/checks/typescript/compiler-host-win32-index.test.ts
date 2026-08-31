import type * as ts from "typescript";
import { expect, it, vi } from "vitest";
import { createSnapshotProgram } from "../../../src/checks/typescript/compiler-host.js";

const captured = vi.hoisted(() => ({
  host: undefined as ts.CompilerHost | undefined,
}));

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual.win32, default: actual.win32 };
});

vi.mock("typescript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("typescript")>();
  return {
    ...actual,
    createProgram(options: ts.CreateProgramOptions) {
      captured.host = options.host;
      return actual.createProgram(options);
    },
  };
});

it("preserves case-insensitive Windows snapshot containment", () => {
  createSnapshotProgram({
    repositoryRoot: "C:\\live",
    snapshotRoot: "C:\\snapshot",
    files: { "src/deep/value.ts": "export const value = 1;" },
    rootNames: [],
    options: { noLib: true, types: [] },
  });

  expect(captured.host).toBeDefined();
  expect(
    [
      "c:\\snapshot\\src",
      "C:/SNAPSHOT/SRC/DEEP",
      "c:\\SNAPSHOT\\src\\deep\\VALUE.TS",
      "C:\\SNAPSHOT\\src\\deeper",
      "D:\\snapshot\\src",
    ].map((directory) => captured.host?.directoryExists?.(directory)),
  ).toEqual([true, true, true, false, false]);
});
