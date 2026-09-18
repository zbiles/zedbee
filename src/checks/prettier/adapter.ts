import { inspectManagedCheck } from "../applicability.js";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
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
import {
  capturedSourceInput,
  capturedSourcePaths,
} from "../../inspection/source-capture.js";
import { prettierOptions } from "./settings.js";
import {
  isGeneratedLockfile,
  isSupportedPrettierPath,
  prettierParserFor,
} from "./supported-path.js";
import { requireProjectPrettierTrust } from "./project-trust.js";
import {
  openProjectFormatter,
  ProjectPrettierFailureError,
  resolveProjectPrettierInstallation,
} from "./project-engine.js";
import type { ProjectFormatterSession } from "./project-engine.js";

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

function finding(
  file: string,
  startLine: number,
  endLine: number,
  engine: "managed" | "project",
): Finding {
  return {
    id: formattingFingerprint(file, startLine, endLine),
    check: "formatting",
    rule: "prettier",
    severity: "error",
    message:
      engine === "managed"
        ? "Staged code does not match Zedbee's managed Prettier format."
        : "Staged code does not match this project's Prettier format.",
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

async function sourceForFile(
  context: CheckRunContext,
  file: string,
): Promise<string | undefined> {
  const targetPath = join(context.snapshots.targetDir, file);
  const captured = capturedSourceInput(context.snapshots.targetDir, file);
  if (captured !== undefined) {
    if (captured.entry === undefined) {
      throw new Error("Missing captured formatting source.");
    }
    if (captured.entry.kind !== "file") return undefined;
    if (captured.text === undefined) {
      throw new Error("Unreadable captured formatting source.");
    }
    return captured.text;
  }
  const metadata = await lstat(targetPath);
  if (!metadata.isFile()) return undefined;
  return readFile(targetPath, "utf8");
}

async function attribute(
  context: CheckRunContext,
  file: string,
  formatted: string,
  source: string,
  engine: "managed" | "project",
): Promise<Finding[]> {
  const transformations = await formattingTransformationRanges(
    source,
    formatted,
    { signal: context.signal },
  );
  const attributed = intersectRanges(transformations, stagedRanges(context, file));
  return attributed.map((range) => finding(file, range.start, range.end, engine));
}

function owningProjectRoot(context: CheckRunContext, file: string): string {
  const candidates = context.targetInspection.workspaces
    .filter(
      (workspace) =>
        workspace.relativeRoot === "." ||
        file.startsWith(`${workspace.relativeRoot}/`),
    )
    .sort((left, right) => right.relativeRoot.length - left.relativeRoot.length);
  return candidates[0]?.relativeRoot ?? ".";
}

async function runProjectFiles(
  context: CheckRunContext,
  files: readonly string[],
  findings: Finding[],
): Promise<CheckResult | undefined> {
  const grouped = new Map<string, string[]>();
  for (const file of files) {
    const projectRoot = owningProjectRoot(context, file);
    const group = grouped.get(projectRoot) ?? [];
    group.push(file);
    grouped.set(projectRoot, group);
  }
  for (const [projectRoot, projectFiles] of grouped) {
    let permit;
    try {
      permit = await requireProjectPrettierTrust(
        context.repositoryRoot,
        projectRoot,
        false,
      );
    } catch {
      return incompleteResult({
        checkId: "formatting",
        durationMs: 0,
        code: "PROJECT_PRETTIER_TRUST_REQUIRED",
        message:
          "Using this project's Prettier requires explicit trust for this checkout.",
        remediation:
          "Run zedbee init with project formatting, or pass --trust-project-prettier for this invocation.",
      });
    }
    let installation;
    try {
      installation = await resolveProjectPrettierInstallation(
        context.repositoryRoot,
        projectRoot,
      );
    } catch (error) {
      if (error instanceof ProjectPrettierFailureError) {
        return incompleteResult({
          checkId: "formatting",
          durationMs: 0,
          code: error.code,
          message: error.message,
          remediation:
            "Install a supported Prettier version in the project, then retry.",
        });
      }
      throw error;
    }
    let session: ProjectFormatterSession;
    try {
      session = await openProjectFormatter({
        checkoutRoot: await realpath(context.repositoryRoot),
        snapshotRoot: context.snapshots.targetDir,
        projectRoot,
        installation,
        permit,
        signal: context.signal,
      });
    } catch (error) {
      if (error instanceof ProjectPrettierFailureError) {
        return incompleteResult({
          checkId: "formatting",
          durationMs: 0,
          code: error.code,
          message: error.message,
          remediation:
            "Review the project Prettier installation and configuration, then retry.",
        });
      }
      throw error;
    }
    try {
      for (const file of projectFiles) {
        if (context.signal.aborted) throw new Error("Formatting check aborted");
        const policy = context.policyForFile("formatting", file, "target");
        if (policy.severity === "off") continue;
        const source = await sourceForFile(context, file);
        if (source === undefined) continue;
        const result = await session.format(file, source);
        if (result.kind === "ignored") continue;
        findings.push(
          ...(await attribute(context, file, result.text, source, "project")),
        );
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      if (error instanceof ProjectPrettierFailureError) {
        return incompleteResult({
          checkId: "formatting",
          durationMs: 0,
          code: error.code,
          message: error.message,
          ...(error.failure.file === undefined
            ? {}
            : { path: error.failure.file }),
          remediation:
            "Fix the project Prettier configuration or plugin, then retry.",
        });
      }
      return incompleteResult({
        checkId: "formatting",
        durationMs: 0,
        code: "PRETTIER_FAILED",
        message: "The project's Prettier could not format a changed file.",
        remediation:
          "Fix the project Prettier configuration or plugin, then retry.",
      });
    } finally {
      await session.close().catch(() => undefined);
    }
  }
  return undefined;
}

// Legacy CheckResult compatibility bridge: managed and project engines both
// return formatted text to the same staged-diff attribution path.
export const prettierAdapter: LegacyCheckResultAdapter = {
  id: "formatting",
  output: "legacy-check-result",

  async planFixes(context, findings) {
    return planPrettierFixes(context, findings);
  },

  inspect: (context: import("../adapter.js").InspectionContext) =>
    inspectManagedCheck("formatting", context),

  async runLegacy(context) {
    const rootEngine = context.config.checks.formatting.engine;
    const hasProjectOverride = context.config.overrides.some(
      (override) => override.checks.formatting?.engine === "project",
    );
    const mayUseProject = rootEngine === "project" || hasProjectOverride;

    let files: string[];
    if (context.config.checks.formatting.when === "always") {
      files = context.config.checks.formatting.engine === "project"
        ? [...context.changeSet.files.values()]
            .filter((file) => file.status !== "deleted")
            .map((file) => file.path)
        : await allSupportedFiles(context.snapshots.targetDir);
      if (context.config.checks.formatting.engine === "project") {
        const inventory = await allSupportedFiles(context.snapshots.targetDir);
        files = [...new Set([...files, ...inventory])];
      } else {
        // The selected view augments, never replaces, the complete live inventory.
        files = [
          ...new Set([
            ...files,
            ...capturedSourcePaths(context.snapshots.targetDir),
          ]),
        ]
          .filter((file) => {
            const captured = capturedSourceInput(
              context.snapshots.targetDir,
              file,
            );
            return (
              isSupportedPrettierPath(file) &&
              (captured === undefined || captured.entry?.kind === "file")
            );
          })
          .sort(compareCodeUnits);
      }
    } else if (mayUseProject) {
      files = [...context.changeSet.files.values()]
        .filter((file) => file.status !== "deleted")
        .map((file) => file.path)
        .sort(compareCodeUnits);
    } else {
      files = relevantFiles(context);
    }
    const unsupported = new Set(
      context.snapshots.unsupportedEntries.map((entry) => entry.path),
    );
    files = files.filter(
      (file) => !unsupported.has(file) && !isGeneratedLockfile(file),
    );
    if (files.length === 0) {
      return skipped();
    }

    const findings: Finding[] = [];
    const managedFiles: string[] = [];
    const projectFiles: string[] = [];
    for (const file of files) {
      const policy = context.policyForFile("formatting", file, "target");
      if (policy.severity === "off") continue;
      if (policy.engine === "project") projectFiles.push(file);
      else if (isSupportedPrettierPath(file)) managedFiles.push(file);
    }

    for (const file of managedFiles) {
      if (context.signal.aborted) {
        throw new Error("Formatting check aborted");
      }
      try {
        const source = await sourceForFile(context, file);
        if (source === undefined) continue;
        const parser = prettierParserFor(file);
        if (parser === undefined) continue;
        const policy = context.policyForFile("formatting", file, "target");
        const formatted = await prettier.format(source, {
          ...prettierOptions(policy.settings),
          filepath: file,
          parser,
        });
        findings.push(...(await attribute(context, file, formatted, source, "managed")));
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

    if (projectFiles.length > 0) {
      const incomplete = await runProjectFiles(context, projectFiles, findings);
      if (incomplete !== undefined) return incomplete;
    }

    return {
      checkId: "formatting",
      status: "completed",
      durationMs: 0,
      findings,
    };
  },
};
