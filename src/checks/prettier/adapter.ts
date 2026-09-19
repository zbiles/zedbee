import { inspectManagedCheck } from "../applicability.js";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import * as prettier from "prettier";
import type { CheckRunContext, LegacyCheckResultAdapter } from "../adapter.js";
import type { CheckApplicability, InspectionContext } from "../adapter.js";
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
  owningProjectRoot,
  ProjectPrettierFailureError,
  resolveProjectPrettierInstallation,
} from "./project-engine.js";
import type { ProjectFormatterSession } from "./project-engine.js";
import type { FormattingProvenance } from "./project-types.js";
import {
  collectProjectFormattingInventory,
  PROJECT_FORMATTING_INVENTORY_MAX_FILES,
} from "./project-inventory.js";
import { PROJECT_FORMAT_SOURCE_MAX_BYTES } from "./project-protocol.js";

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

function skipped(reason: string): CheckResult {
  return {
    checkId: "formatting",
    status: "skipped",
    durationMs: 0,
    findings: [],
    skipReason: reason,
  };
}

async function sourceForFile(
  context: CheckRunContext,
  file: string,
  maxBytes?: number,
): Promise<string | undefined> {
  const targetPath = join(context.snapshots.targetDir, file);
  const captured = capturedSourceInput(context.snapshots.targetDir, file);
  if (captured !== undefined) {
    if (captured.entry === undefined) {
      throw new Error("Missing captured formatting source.");
    }
    if (captured.entry.kind !== "file") return undefined;
    if (maxBytes !== undefined && captured.byteLength > maxBytes) {
      throw new ProjectFormattingSourceLimitError(file);
    }
    if (captured.text === undefined) {
      throw new Error("Unreadable captured formatting source.");
    }
    return captured.text;
  }
  const metadata = await lstat(targetPath, { bigint: true });
  if (!metadata.isFile()) return undefined;
  if (maxBytes !== undefined && metadata.size > BigInt(maxBytes)) {
    throw new ProjectFormattingSourceLimitError(file);
  }
  return readFile(targetPath, "utf8");
}

class ProjectFormattingSourceLimitError extends Error {
  constructor(readonly file: string) {
    super("Project formatting source exceeds its size limit.");
    this.name = "ProjectFormattingSourceLimitError";
  }
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
  const attributed = intersectRanges(
    transformations,
    stagedRanges(context, file),
  );
  return attributed.map((range) =>
    finding(file, range.start, range.end, engine),
  );
}

async function runProjectFiles(
  context: CheckRunContext,
  files: readonly string[],
  findings: Finding[],
  provenance: FormattingProvenance[],
  ignored: { file: string; reason: string }[],
  checked: Set<string>,
): Promise<CheckResult | undefined> {
  const grouped = new Map<string, string[]>();
  for (const file of files) {
    const projectRoot = owningProjectRoot(
      context.targetInspection.workspaces,
      file,
    );
    const group = grouped.get(projectRoot) ?? [];
    group.push(file);
    grouped.set(projectRoot, group);
  }
  for (const [projectRoot, projectFiles] of grouped) {
    const selectedConfigFiles = new Set<string>();
    // Invocation-only consent comes only from the trusted parent CLI flag;
    // tracked configuration can never supply executable-code permission.
    let permit;
    try {
      permit = await requireProjectPrettierTrust(
        context.repositoryRoot,
        projectRoot,
        context.projectPrettierTrust === true,
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
        context.snapshots.targetDir,
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
        const support = await session.classify(file);
        if (support.kind === "ignored") {
          ignored.push({ file, reason: support.reason });
          continue;
        }
        if (support.configFile !== undefined) {
          selectedConfigFiles.add(support.configFile);
        }
        const source = await sourceForFile(
          context,
          file,
          PROJECT_FORMAT_SOURCE_MAX_BYTES,
        );
        if (source === undefined) continue;
        const result = await session.format(file, source);
        if (result.kind === "ignored") {
          // Ignored and unsupported files stay distinguishable from files that
          // were actually formatted and passed.
          ignored.push({ file, reason: result.reason });
          continue;
        }
        checked.add(file);
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
      if (error instanceof ProjectFormattingSourceLimitError) {
        return incompleteResult({
          checkId: "formatting",
          durationMs: 0,
          code: "PROJECT_PRETTIER_OUTPUT_LIMIT",
          message: `${error.file} is too large for project formatting.`,
          path: error.file,
          remediation:
            "Exclude this file from formatting or reduce it below the project formatting size limit.",
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
      await session.close();
    }
    provenance.push(
      Object.freeze({
        engine: "project",
        version: installation.version,
        projectRoot,
        configFiles: Object.freeze(
          [...selectedConfigFiles].sort(compareCodeUnits),
        ),
      }),
    );
  }
  provenance.sort((left, right) =>
    compareCodeUnits(left.projectRoot, right.projectRoot),
  );
  return undefined;
}

function mayUseProjectEngine(
  context: Pick<CheckRunContext, "config"> | InspectionContext,
): boolean {
  return (
    context.config.checks.formatting.engine === "project" ||
    context.config.overrides.some(
      (override) => override.checks.formatting?.engine === "project",
    )
  );
}

// Legacy CheckResult compatibility bridge: managed and project engines both
// return formatted text to the same staged-diff attribution path.
export const prettierAdapter: LegacyCheckResultAdapter = {
  id: "formatting",
  output: "legacy-check-result",

  async planFixes(context, findings) {
    return planPrettierFixes(context, findings);
  },

  inspect: async (context: InspectionContext): Promise<CheckApplicability> => {
    // Project mode must let the selected formatter and its plugins decide
    // support, so applicability accepts bounded changed files without the
    // managed parser allowlist and without executing any configuration.
    if (!mayUseProjectEngine(context)) {
      return inspectManagedCheck("formatting", context);
    }
    const changed = [...context.changeSet.files.values()].filter(
      (file) => file.status !== "deleted",
    );
    const bounded = changed.filter((file) => !isGeneratedLockfile(file.path));
    if (context.config.checks.formatting.when === "always") {
      return {
        applies: true,
        executionClass: "lightweight",
        requiresBaseline: false,
        targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
      };
    }
    if (bounded.length === 0) {
      return {
        applies: false,
        reason: "No supported changed files",
      };
    }
    return {
      applies: true,
      executionClass: "lightweight",
      requiresBaseline: false,
      targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
    };
  },

  async runLegacy(context) {
    const rootEngine = context.config.checks.formatting.engine;
    const mayUseProject = mayUseProjectEngine(context);

    let files: string[];
    if (context.config.checks.formatting.when === "always") {
      if (mayUseProject) {
        // The project engine decides support itself; the inventory is a
        // bounded regular-file view independent of the managed allowlist.
        const inventory = await collectProjectFormattingInventory(
          context.snapshots.targetDir,
        );
        const combined = new Set(inventory.files);
        let inventoryTruncated = inventory.truncated;
        for (const file of [
          ...capturedSourcePaths(context.snapshots.targetDir),
        ].sort(compareCodeUnits)) {
          const captured = capturedSourceInput(
            context.snapshots.targetDir,
            file,
          );
          if (
            combined.has(file) ||
            isGeneratedLockfile(file) ||
            captured?.entry?.kind !== "file"
          ) {
            continue;
          }
          if (combined.size === PROJECT_FORMATTING_INVENTORY_MAX_FILES) {
            inventoryTruncated = true;
            break;
          }
          combined.add(file);
        }
        if (inventoryTruncated) {
          return incompleteResult({
            checkId: "formatting",
            durationMs: 0,
            code: "PROJECT_PRETTIER_INVENTORY_LIMIT",
            message:
              "Project formatting found more files than it can safely inventory.",
            remediation:
              "Narrow formatting with path overrides or run formatting on a smaller project.",
          });
        }
        files = [...combined].sort(compareCodeUnits);
      } else {
        files = await allSupportedFiles(context.snapshots.targetDir);
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
      return skipped("No supported target files");
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

    let managedChecked = 0;
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
        managedChecked++;
        findings.push(
          ...(await attribute(context, file, formatted, source, "managed")),
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

    const provenance: FormattingProvenance[] = [];
    const ignored: { file: string; reason: string }[] = [];
    const checked = new Set<string>();
    if (projectFiles.length > 0) {
      const incomplete = await runProjectFiles(
        context,
        projectFiles,
        findings,
        provenance,
        ignored,
        checked,
      );
      if (incomplete !== undefined) return incomplete;
    }

    const formattingCoverage = Object.freeze({
      checkedFiles: managedChecked + checked.size,
      ignoredFiles: ignored.filter((entry) => entry.reason !== "unsupported")
        .length,
      unsupportedFiles: ignored.filter(
        (entry) => entry.reason === "unsupported",
      ).length,
    });
    // An all-ignored run must not be presented as having checked those files.
    if (
      projectFiles.length > 0 &&
      managedFiles.length === 0 &&
      checked.size === 0 &&
      ignored.length > 0
    ) {
      return {
        ...skipped(
          `All ${ignored.length} target file${
            ignored.length === 1 ? "" : "s"
          } were ignored or unsupported under the project formatter`,
        ),
        formattingCoverage,
      };
    }

    return {
      checkId: "formatting",
      status: "completed",
      durationMs: 0,
      findings,
      ...(mayUseProject ? { formattingCoverage } : {}),
      ...(provenance.length > 0
        ? { formattingProvenance: Object.freeze(provenance) }
        : {}),
    };
  },
};
