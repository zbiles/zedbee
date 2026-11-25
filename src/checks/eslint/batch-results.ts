import { relative, sep } from "node:path";

export class InvalidEslintBatch extends Error {
  constructor() {
    super("ESLint returned incomplete or unexpected file coverage.");
  }
}

/** Ignored files are represented by ESLint warning results and count as covered. */
export function validatedBatchResults<T extends { filePath: string }>(
  root: string,
  files: readonly string[],
  results: readonly T[],
): readonly { file: string; result: T }[] {
  const remaining = new Set(files);
  const checked = results.map((result) => {
    const file = relative(root, result.filePath).split(sep).join("/");
    if (!remaining.delete(file)) throw new InvalidEslintBatch();
    return { file, result };
  });
  if (remaining.size > 0) throw new InvalidEslintBatch();
  return checked;
}
