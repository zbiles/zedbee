import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import tseslint from "typescript-eslint";
import { vi } from "vitest";

/** Preserve real upstream parsing; count the public input mode that creates syntax. */
export function countSyntaxParses(): () => number {
  const parser =
    tseslint.parser as unknown as typeof import("@typescript-eslint/parser");
  let count = 0;
  const original = parser.parseForESLint;
  vi.spyOn(parser, "parseForESLint").mockImplementation((code, options) => {
    if (typeof code === "string") count += 1;
    return original(code, options);
  });
  return () => count;
}

/** Observe real checked-descriptor reads, without replacing served bytes. */
export function countContainedSourceReads(suffix: string): () => number {
  let count = 0;
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).replaceAll("\\", "/").endsWith(suffix)) {
      const read = handle.readFile;
      vi.spyOn(handle, "readFile").mockImplementation((...readArgs) => {
        count += 1;
        return Reflect.apply(read, handle, readArgs);
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  return () => count;
}

export function restoreAnalysisProbes(): void {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
}
