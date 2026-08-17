import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import * as prettier from "prettier";
import type { CheckRunContext, LegacyCheckResultAdapter } from "../adapter.js";
import type { CheckResult, Finding } from "../../core/types.js";
import type { ChangedFile } from "../../git/change-set.js";
import { formattingFingerprint } from "./fingerprint.js";
import { formattingTransformationRanges, intersectRanges } from "./format-diff.js";
import { compareCodeUnits } from "../../core/compare.js";
import { incompleteResult } from "../incomplete-result.js";

const PARSERS = {
  ".css": "css",
  ".js": "babel",
  ".json": "json",
  ".jsonc": "json",
  ".jsx": "babel",
  ".md": "markdown",
  ".markdown": "markdown",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".yaml": "yaml",
  ".yml": "yaml"
} as const;

type SupportedExtension = keyof typeof PARSERS;

function parserFor(file: string): (typeof PARSERS)[SupportedExtension] | undefined {
  return PARSERS[extname(file).toLowerCase() as SupportedExtension];
}

function relevantFiles(context: CheckRunContext): string[] {
  return [...context.changeSet.files.values()]
    .filter((file) => file.status !== "deleted" && parserFor(file.path) !== undefined)
    .map((file) => file.path)
    .sort(compareCodeUnits);
}

async function allSupportedFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await allSupportedFiles(root, fullPath)));
    } else if (entry.isFile()) {
      const repositoryPath = relative(root, fullPath).split(sep).join("/");
      if (parserFor(repositoryPath) !== undefined) {
        files.push(repositoryPath);
      }
    }
  }
  return files;
}

function stagedRanges(context: CheckRunContext, file: string): ChangedFile["addedRanges"] {
  return context.changeSet.files.get(file)?.addedRanges ?? [];
}

function finding(file: string, startLine: number, endLine: number): Finding {
  return {
    id: formattingFingerprint(file, startLine, endLine),
    check: "formatting",
    rule: "prettier",
    severity: "error",
    message: "Staged code does not match Zedbee's managed Prettier format.",
    location: { file, startLine, endLine },
    remediation: "Format the staged lines with Prettier, then stage the result.",
    attribution: {
      kind: "transformation-diff",
      staged: true,
      evidence: [`Prettier transformation overlaps staged target lines ${startLine}-${endLine}`]
    }
  };
}

function skipped(): CheckResult {
  return {
    checkId: "formatting",
    status: "skipped",
    durationMs: 0,
    findings: [],
    skipReason: "No supported target files"
  };
}

// Legacy CheckResult compatibility bridge: Task 7 converts normalized
// observation sets centrally; Prettier remains transformation-diff based until then.
export const prettierAdapter: LegacyCheckResultAdapter = {
  id: "formatting",
  output: "legacy-check-result",

  async inspect(context) {
    if (context.config.checks.formatting.when === "always") {
      return {
        applies: true,
        executionClass: "lightweight",
        requiresBaseline: false,
        targets: [{ id: ".", kind: "repository", relativeRoot: "." }]
      };
    }
    const applies = [...context.changeSet.files.values()].some(
      (file) => file.status !== "deleted" && parserFor(file.path) !== undefined
    );
    return applies
      ? {
          applies: true,
          executionClass: "lightweight",
          requiresBaseline: false,
          targets: [{ id: ".", kind: "repository", relativeRoot: "." }]
        }
      : { applies: false, reason: "No supported staged files" };
  },

  async runLegacy(context) {
    let files =
      context.config.checks.formatting.when === "always"
        ? await allSupportedFiles(context.snapshots.targetDir)
        : relevantFiles(context);
    const unsupported = new Set(context.snapshots.unsupportedEntries.map((entry) => entry.path));
    files = files.filter((file) => !unsupported.has(file));
    if (files.length === 0) {
      return skipped();
    }

    const findings: Finding[] = [];
    for (const file of files) {
      if (context.signal.aborted) {
        throw new Error("Formatting check aborted");
      }
      const targetPath = join(context.snapshots.targetDir, file);
      try {
        const metadata = await lstat(targetPath);
        if (!metadata.isFile()) {
          continue;
        }
        const source = await readFile(targetPath, "utf8");
        const parser = parserFor(file);
        if (parser === undefined) {
          continue;
        }
        const formatted = await prettier.format(source, {
          filepath: file,
          parser
        });
        const transformations = formattingTransformationRanges(source, formatted);
        const attributed = intersectRanges(transformations, stagedRanges(context, file));
        findings.push(...attributed.map((range) => finding(file, range.start, range.end)));
      } catch {
        return incompleteResult({
          checkId: "formatting",
          durationMs: 0,
          code: "PRETTIER_FAILED",
          message: `Prettier could not analyze ${file}.`,
          path: file,
          remediation: "Fix the parser or file-reading error, then stage the result."
        });
      }
    }

    return {
      checkId: "formatting",
      status: "completed",
      durationMs: 0,
      findings
    };
  }
};
