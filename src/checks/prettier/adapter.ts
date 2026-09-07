import { inspectManagedCheck } from "../applicability.js";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import * as prettier from "prettier";
import type { CheckRunContext, LegacyCheckResultAdapter } from "../adapter.js";
import type { CheckResult, Finding } from "../../core/types.js";
import type { ChangedFile } from "../../git/change-set.js";
import { formattingFingerprint } from "./fingerprint.js";
import { managedAutomaticFixFor } from "../../attribution/fingerprint.js";
import {
  formattingTransformationRanges,
  intersectRanges,
} from "./format-diff.js";
import { compareCodeUnits } from "../../core/compare.js";
import { incompleteResult } from "../incomplete-result.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import { planPrettierFixes } from "../../fixes/prettier-provider.js";
import { prettierOptions } from "./settings.js";
import {
  isSupportedPrettierPath,
  prettierParserFor,
} from "./supported-path.js";

function relevantFiles(context: CheckRunContext): string[] {
  return [...context.changeSet.files.values()]
    .filter(
      (file) => file.status !== "deleted" && isSupportedPrettierPath(file.path),
    )
    .map((file) => file.path)
    .sort(compareCodeUnits);
}

async function allSupportedFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  )) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await allSupportedFiles(root, fullPath)));
    } else if (entry.isFile()) {
      const repositoryPath = relative(root, fullPath).split(sep).join("/");
      if (isSupportedPrettierPath(repositoryPath)) {
        files.push(repositoryPath);
      }
    }
  }
  return files;
}

function stagedRanges(
  context: CheckRunContext,
  file: string,
): ChangedFile["addedRanges"] {
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
    remediation:
      "Run zedbee fix formatting, review the working-file changes, and stage the desired result.",
    automaticFix: managedAutomaticFixFor("formatting")!,
    attribution: {
      kind: "transformation-diff",
      staged: true,
      evidence: [
        `Prettier transformation overlaps staged target lines ${startLine}-${endLine}`,
      ],
    },
  };
}

function skipped(): CheckResult {
  return {
    checkId: "formatting",
    status: "skipped",
    durationMs: 0,
    findings: [],
    skipReason: "No supported target files",
  };
}

// Legacy CheckResult compatibility bridge: Task 7 converts normalized
// observation sets centrally; Prettier remains transformation-diff based until then.
export const prettierAdapter: LegacyCheckResultAdapter = {
  id: "formatting",
  output: "legacy-check-result",

  async planFixes(context, findings) {
    return planPrettierFixes(context, findings);
  },

  inspect: (context: import("../adapter.js").InspectionContext) =>
    inspectManagedCheck("formatting", context),

  async runLegacy(context) {
    let files =
      context.config.checks.formatting.when === "always"
        ? await allSupportedFiles(context.snapshots.targetDir)
        : relevantFiles(context);
    const unsupported = new Set(
      context.snapshots.unsupportedEntries.map((entry) => entry.path),
    );
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
        const parser = prettierParserFor(file);
        if (parser === undefined) {
          continue;
        }
        const policy = context.policyForFile("formatting", file, "target");
        if (policy.severity === "off") {
          continue;
        }
        const formatted = await prettier.format(source, {
          ...prettierOptions(policy.settings),
          filepath: file,
          parser,
        });
        const transformations = await formattingTransformationRanges(
          source,
          formatted,
          { signal: context.signal },
        );
        const attributed = intersectRanges(
          transformations,
          stagedRanges(context, file),
        );
        findings.push(
          ...attributed.map((range) => finding(file, range.start, range.end)),
        );
      } catch (error) {
        if (context.signal.aborted) throw error;
        if (error instanceof CheckIncompleteError) {
          return incompleteResult({
            checkId: "formatting",
            durationMs: 0,
            code: error.code,
            message: `The formatting comparison for ${file} exceeded its time limit.`,
            path: file,
            remediation: error.remediation,
          });
        }
        return incompleteResult({
          checkId: "formatting",
          durationMs: 0,
          code: "PRETTIER_FAILED",
          message: `Prettier could not analyze ${file}.`,
          path: file,
          remediation:
            "Fix the parser or file-reading error, then stage the result.",
        });
      }
    }

    return {
      checkId: "formatting",
      status: "completed",
      durationMs: 0,
      findings,
    };
  },
};
