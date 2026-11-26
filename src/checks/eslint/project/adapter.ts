import { SUPPORTED_PROJECT_ESLINT_VERSION } from "./supported-version.js";
import { loadConfig } from "../../../config/load-config.js";
import { resolveConfig } from "../../../config/profiles.js";
import { resolveWorkspaceLintPolicy } from "../../../config/target-policy.js";
import { normalizeRepositoryRelativePath } from "../../../attribution/fingerprint.js";
import { relative } from "node:path";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { CheckObservationSet, CheckRunContext } from "../../adapter.js";
import { CheckIncompleteError } from "../../incomplete-error.js";
import { pairLocationObservations } from "../../../attribution/pair-locations.js";
import { convertProjectEslintDiagnostic } from "./diagnostics.js";
import { runProjectEslint } from "./engine.js";
import {
  requireProjectEslintTrust,
  projectEslintSourceMessagesAllowed,
} from "./trust.js";
import { ProjectEslintFailureError } from "./types.js";
import { ESLINT_CONFIG_FILE_NAMES } from "./config-files.js";
import type { Observation } from "../../../core/types.js";
import { renamedPaths } from "../../../attribution/source-moves.js";

const LINTABLE_SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;

const readSources = async (root: string, files: readonly string[]) =>
  Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        await readFile(join(root, file), "utf8"),
      ]),
    ),
  );

function projectEslintIncomplete(
  error: unknown,
): CheckIncompleteError {
  return new CheckIncompleteError(
    error instanceof ProjectEslintFailureError
      ? {
          code: error.code,
          message: error.message,
          remediation: `Verify the selected project's ESLint ${SUPPORTED_PROJECT_ESLINT_VERSION} installation, npm lockfile, supported flat configuration, and explicit ESLint trust. Run zedbee doctor for setup details. No managed fallback was used.`,
        }
      : {
          code: "PROJECT_ESLINT_ANALYSIS_FAILED",
          message:
            "Project ESLint could not complete analysis of the captured configuration and source.",
          remediation: `Verify the selected project's ESLint ${SUPPORTED_PROJECT_ESLINT_VERSION} installation, npm lockfile, supported flat configuration, and explicit ESLint trust. Run zedbee doctor for setup details. No managed fallback was used.`,
        },
  );
}

/** Reads only sources needed to relocate an observation, including renames. */
const pairingSources = async (input: {
  readonly baselineDir: string;
  readonly targetDir: string;
  readonly baselineFiles: readonly string[];
  readonly targetFiles: readonly string[];
  readonly baselineObservations: readonly Observation[];
  readonly targetObservations: readonly Observation[];
  readonly changeSet: CheckRunContext["changeSet"];
}) => {
  const renames = renamedPaths(input.changeSet.files);
  const baselineNeeded = new Set(input.baselineFiles);
  const targetNeeded = new Set(input.targetFiles);
  for (const observation of input.targetObservations) {
    const file = observation.location?.file;
    if (file !== undefined) targetNeeded.add(file);
    const previous = file === undefined ? undefined : renames.get(file);
    if (previous !== undefined) baselineNeeded.add(previous);
  }
  for (const observation of input.baselineObservations) {
    const file = observation.location?.file;
    if (file === undefined) continue;
    const targetPath = renames.get(file) ?? file;
    if (targetNeeded.has(targetPath)) continue;
    baselineNeeded.add(file);
    targetNeeded.add(targetPath);
  }
  const baselineReads = [...baselineNeeded].filter(
    (file) => !input.baselineFiles.includes(file),
  );
  const targetReads = [...targetNeeded].filter(
    (file) => !input.targetFiles.includes(file),
  );
  return {
    baseline: await readSources(
      input.baselineDir,
      baselineReads.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    target: await readSources(
      input.targetDir,
      targetReads.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
};

async function hasConfiguration(
  root: string,
  project: string,
): Promise<boolean> {
  let directory = resolve(root, project);
  for (;;) {
    for (const name of ESLINT_CONFIG_FILE_NAMES) {
      if (
        await access(join(directory, name)).then(
          () => true,
          () => false,
        )
      )
        return true;
    }
    const manifest = await readFile(
      join(directory, "package.json"),
      "utf8",
    ).catch(() => "");
    try {
      if (Object.hasOwn(JSON.parse(manifest), "eslintConfig")) return true;
    } catch {
      /* Not configuration presence. */
    }
    if (directory === root || dirname(directory) === directory) return false;
    directory = dirname(directory);
  }
}
export async function collectProjectEslint(
  context: CheckRunContext,
): Promise<CheckObservationSet> {
  try {
    const checkoutRoot = await realpath(context.repositoryRoot);
    const projectRoot = context.target.relativeRoot;
    const workspaceIn = (inspection: CheckRunContext["targetInspection"]) =>
      inspection.workspaces.find((w) => w.relativeRoot === projectRoot);
    const permit = await requireProjectEslintTrust(checkoutRoot, projectRoot);
    const full =
      context.config.reporting.projectEslintMessages === "full" &&
      projectEslintSourceMessagesAllowed(permit);
    const filesFor = (side: "baseline" | "target") => {
      const inspection =
        side === "baseline"
          ? context.baselineInspection
          : context.targetInspection;
      return (
        workspaceIn(inspection)?.sourceFiles.filter(
          (file) =>
            LINTABLE_SOURCE.test(file) &&
            context.policyForFile("lint", file, side).severity !== "off",
        ) ?? []
      );
    };
    const before = filesFor("baseline"),
      after = filesFor("target");
    const input = {
      checkoutRoot,
      projectRoot,
      signal: context.signal,
      permit,
      messages: full ? ("full" as const) : ("redacted" as const),
      allowSourceMessages: full,
      installationSnapshotRoot: context.snapshots.targetDir,
    };
    const target = await runProjectEslint({
      ...input,
      snapshotRoot: context.snapshots.targetDir,
      files: after,
    });
    const relativeConfig = normalizeRepositoryRelativePath(
      relative(
        resolve(context.repositoryRoot),
        resolve(
          context.config.configPath ??
            join(context.repositoryRoot, ".zedbeerc.jsonc"),
        ),
      ),
    );
    const baselineConfigPath = join(
      context.snapshots.baselineDir,
      relativeConfig,
    );
    const baselineConfig = await access(baselineConfigPath).then(
      () => loadConfig(context.snapshots.baselineDir, baselineConfigPath),
      () => resolveConfig(undefined),
    );
    const baselineWorkspace = workspaceIn(context.baselineInspection);
    const previousPolicy =
      baselineWorkspace === undefined
        ? undefined
        : resolveWorkspaceLintPolicy(baselineConfig, baselineWorkspace);
    const baselinePresent =
      previousPolicy?.engine === "project" &&
      previousPolicy.severity !== "off" &&
      (await hasConfiguration(context.snapshots.baselineDir, projectRoot));
    const baseline =
      baselinePresent && before.length > 0
        ? await runProjectEslint({
            ...input,
            snapshotRoot: context.snapshots.baselineDir,
            files: before,
          })
        : undefined;
    const baselineObservations =
      baseline?.diagnostics.map((diagnostic) =>
        convertProjectEslintDiagnostic(diagnostic, full),
      ) ?? [];
    const targetObservations = target.diagnostics.map((diagnostic) =>
      convertProjectEslintDiagnostic(diagnostic, full),
    );
    const sources = await pairingSources({
      baselineDir: context.snapshots.baselineDir,
      targetDir: context.snapshots.targetDir,
      baselineFiles: before,
      targetFiles: after,
      baselineObservations,
      targetObservations,
      changeSet: context.changeSet,
    });
    const paired = pairLocationObservations(
      {
        observations: baselineObservations,
        files: sources.baseline,
      },
      {
        observations: targetObservations,
        files: sources.target,
      },
      context.changeSet,
    );
    if (target.version !== SUPPORTED_PROJECT_ESLINT_VERSION)
      throw new ProjectEslintFailureError("PROJECT_ESLINT_VERSION_UNSUPPORTED");
    return {
      checkId: "lint",
      target: context.target,
      ...paired,
      projectDelta: true,
      eslintAnalysis: {
        version: target.version,
        excludedFiles:
          (workspaceIn(context.targetInspection)?.sourceFiles.filter((file) =>
            LINTABLE_SOURCE.test(file),
          ).length ?? 0) - after.length,
        checkedFiles: target.checkedFiles.length,
        ignoredFiles: target.ignoredFiles.length,
        baseline: baseline === undefined ? "new-coverage" : "compared",
        messages: target.messages,
        ...(context.config.reporting.projectEslintMessages === "full" && !full
          ? { messageNotice: "permission-required" as const }
          : {}),
      },
    };
  } catch (error) {
    context.signal.throwIfAborted();
    throw projectEslintIncomplete(error);
  }
}
