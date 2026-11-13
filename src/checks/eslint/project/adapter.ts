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

async function hasConfiguration(
  root: string,
  project: string,
): Promise<boolean> {
  let directory = resolve(root, project);
  for (;;) {
    for (const name of [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      "eslint.config.ts",
      "eslint.config.mts",
      "eslint.config.cts",
      ".eslintrc",
      ".eslintrc.json",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.yml",
      ".eslintrc.yaml",
    ]) {
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
        inspection.workspaces
          .find((w) => w.relativeRoot === projectRoot)
          ?.sourceFiles.filter(
            (file) =>
              /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu.test(file) &&
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
    const baselineWorkspace = context.baselineInspection.workspaces.find(
      (w) => w.relativeRoot === projectRoot,
    );
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
    const loadSources = async (root: string, files: readonly string[]) =>
      Object.fromEntries(
        await Promise.all(
          files.map(async (file) => [
            file,
            await readFile(join(root, file), "utf8"),
          ]),
        ),
      );
    const paired = pairLocationObservations(
      {
        observations:
          baseline?.diagnostics.map((d) =>
            convertProjectEslintDiagnostic(d, full),
          ) ?? [],
        files: await loadSources(context.snapshots.baselineDir, before),
      },
      {
        observations: target.diagnostics.map((d) =>
          convertProjectEslintDiagnostic(d, full),
        ),
        files: await loadSources(context.snapshots.targetDir, after),
      },
      context.changeSet,
    );
    if (target.version !== "9.39.5")
      throw new ProjectEslintFailureError("PROJECT_ESLINT_VERSION_UNSUPPORTED");
    return {
      checkId: "lint",
      target: context.target,
      ...paired,
      projectDelta: true,
      eslintAnalysis: {
        version: target.version,
        excludedFiles:
          (context.targetInspection.workspaces
            .find((w) => w.relativeRoot === projectRoot)
            ?.sourceFiles.filter((file) =>
              /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu.test(file),
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
    throw new CheckIncompleteError({
      code:
        error instanceof ProjectEslintFailureError
          ? error.code
          : "PROJECT_ESLINT_ANALYSIS_FAILED",
      message:
        error instanceof ProjectEslintFailureError
          ? error.message
          : "Project ESLint could not complete analysis of the captured configuration and source.",
      remediation:
        "Verify the selected project's ESLint 9.39.5 installation, npm lockfile, supported flat configuration, and explicit ESLint trust. Run zedbee doctor for setup details. No managed fallback was used.",
    });
  }
}
