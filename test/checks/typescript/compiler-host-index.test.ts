import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSnapshotProgram } from "../../../src/checks/typescript/compiler-host.js";

const captured = vi.hoisted(() => ({
  host: undefined as ts.CompilerHost | undefined,
}));

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

afterEach(() => {
  vi.restoreAllMocks();
  captured.host = undefined;
});

function snapshotHost(
  files: Record<string, string> = {
    "src/deep/value.ts": "export const value = 1;",
  },
) {
  createSnapshotProgram({
    repositoryRoot: path.resolve("/virtual/zedbee-live"),
    snapshotRoot: path.resolve("/virtual/zedbee-snapshot"),
    files,
    rootNames: [],
    options: { noLib: true, types: [] },
  });
  expect(captured.host).toBeDefined();
  return captured.host!;
}

describe("snapshot directory index", () => {
  it("answers repeated directory probes without enumerating snapshot files", () => {
    const files = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `src/component-${index}/value.ts`,
        "export const value = 1;",
      ]),
    );
    const host = snapshotHost(files);
    const keys = vi.spyOn(Map.prototype, "keys");
    const answers = [
      "/virtual/zedbee-snapshot/src/component-31",
      "/virtual/zedbee-snapshot/src/missing",
      "/virtual/zedbee-live/missing",
    ].map((directory) => host.directoryExists?.(directory));
    const enumerations = keys.mock.calls.length;
    keys.mockRestore();

    expect(answers).toEqual([true, false, true]);
    expect(enumerations).toBe(0);
  });

  it("preserves ancestor, exact-file, repository, and library boundaries", () => {
    const host = snapshotHost();
    const libraryRoot = path.dirname(ts.getDefaultLibFilePath({}));
    const directories = [
      path.parse(path.resolve("/virtual/zedbee-snapshot")).root,
      "/virtual",
      "/virtual/zedbee-snapshot",
      "/virtual/zedbee-snapshot/src/deep/../deep",
      "/virtual/zedbee-snapshot/src/deep/value.ts",
      "/virtual/zedbee-snapshot/src/deep/value.ts/child",
      "/virtual/zedbee-snapshot/src/deeper",
      "/virtual/zedbee-snapshot-missing",
      "/virtual/zedbee-live/missing",
      libraryRoot,
      path.join(libraryRoot, "missing-directory"),
      path.dirname(libraryRoot),
    ];

    expect(
      directories.map((directory) => host.directoryExists?.(directory)),
    ).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(host.fileExists(path.join(process.cwd(), "package.json"))).toBe(
      false,
    );
    expect(
      host.readFile(path.join(process.cwd(), "package.json")),
    ).toBeUndefined();
    expect(host.fileExists(path.join(libraryRoot, "lib.es5.d.ts"))).toBe(true);
  });

  it("keeps directory membership local to each snapshot", () => {
    const first = snapshotHost({
      "src/first/value.ts": "export const value = 1;",
    });
    const second = snapshotHost({
      "src/second/value.ts": "export const value = 2;",
    });

    expect(first.directoryExists?.("/virtual/zedbee-snapshot/src/first")).toBe(
      true,
    );
    expect(second.directoryExists?.("/virtual/zedbee-snapshot/src/first")).toBe(
      false,
    );
    expect(first.directoryExists?.("/virtual/zedbee-snapshot/src/second")).toBe(
      false,
    );
    expect(
      second.directoryExists?.("/virtual/zedbee-snapshot/src/second"),
    ).toBe(true);
  });
});
