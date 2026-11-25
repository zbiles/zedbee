import { join } from "node:path";
import type { ESLint } from "eslint";

/** Model a completed, clean lint result for every requested path. */
export function cleanEslintResults(
  root: string,
  patterns: string | string[],
): ESLint.LintResult[] {
  return (typeof patterns === "string" ? [patterns] : patterns).map((path) => ({
    filePath: join(root, path),
    messages: [],
    suppressedMessages: [],
    errorCount: 0,
    fatalErrorCount: 0,
    warningCount: 0,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    usedDeprecatedRules: [],
  }));
}
