import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExecutableEvaluatedConfig,
  EvaluatedExecutableImports,
  InitFormattingDetection,
  InitFormattingImport,
} from "./types.js";
import type { ImportableNativeConfig } from "../checks/prettier/project-types.js";
import { discoverProjectPrettier } from "./prettier-discovery.js";
import { previewPrettierSettingsImport } from "./prettier-import.js";
import {
  readProjectPrettierTrust,
  requireProjectPrettierTrust,
} from "../checks/prettier/project-trust.js";
import {
  openProjectFormatter,
  resolveProjectPrettierInstallation,
} from "../checks/prettier/project-engine.js";

export interface FormattingSetup {
  readonly imported: InitFormattingImport;
  readonly detection: readonly InitFormattingDetection[];
  /** Primary project used for messages and executable-config evaluation. */
  readonly projectRoot: string;
  /** Every discovered project root; project mode enables each of them. */
  readonly projectRoots: readonly string[];
  /** Roots that already hold a local executable-code grant. */
  readonly storedTrustRoots: readonly string[];
  readonly executableTargets: readonly ExecutableConfigTarget[];
}
export async function resolveFormattingSetup(
  repositoryRoot: string,
): Promise<FormattingSetup> {
  // Discovery failures are reported; they are never converted into an empty
  // setup that would misrepresent the project.
  const discoveries = await discoverProjectPrettier(repositoryRoot);
  const projectRoots = discoveries.map((entry) => entry.projectRoot);
  const storedTrustRoots: string[] = [];
  for (const root of projectRoots) {
    const stored = await readProjectPrettierTrust(repositoryRoot, root).catch(
      () => undefined,
    );
    if (stored === "v1") storedTrustRoots.push(root);
  }
  const projectRoot =
    discoveries.find((entry) => entry.projectRoot === ".")?.projectRoot ??
    discoveries[0]?.projectRoot ??
    ".";
  const preview = await previewPrettierSettingsImport(repositoryRoot);
  const sharedConfigs = new Map(
    preview.sharedConfigs.map(
      (entry) => [entry.projectRoot, entry.specifier] as const,
    ),
  );
  const detection = Object.freeze(
    discoveries.map((entry) => {
      const sharedConfig = sharedConfigs.get(entry.projectRoot);
      return Object.freeze({
        projectRoot: entry.projectRoot,
        ...(entry.version === undefined ? {} : { version: entry.version }),
        status: entry.status,
        executableConfig: entry.executableConfig,
        configPaths: Object.freeze([...entry.configPaths]),
        ...(sharedConfig === undefined ? {} : { sharedConfig }),
      });
    }),
  );
  const limitations = [...preview.limitations];
  const executableTargets: ExecutableConfigTarget[] = [
    ...preview.executableConfigs.map(({ projectRoot, configPath }) => ({
      projectRoot,
      target: { configPath },
    })),
  ];
  for (const { projectRoot, configPath, specifier } of preview.sharedConfigs)
    executableTargets.push({
      projectRoot,
      target: { sharedConfig: specifier, configPath },
    });
  return Object.freeze({
    imported: Object.freeze({
      settings: preview.settings,
      overrides: preview.overrides,
      ...(preview.pathExclusions === undefined
        ? {}
        : { pathExclusions: preview.pathExclusions }),
      limitations: Object.freeze(limitations),
    }),
    detection,
    projectRoot,
    projectRoots: Object.freeze(projectRoots),
    storedTrustRoots: Object.freeze(storedTrustRoots),
    executableTargets: Object.freeze(executableTargets),
  });
}

interface EvaluatedExecutableImport {
  readonly nativeConfig: ImportableNativeConfig;
  /** Exact working-copy bytes the evaluation was bound to. */
  readonly evaluatedConfig: ExecutableEvaluatedConfig;
}

/**
 * Separately consented one-time evaluation of an executable or shared Prettier
 * configuration. Setup deliberately differs from scans: it evaluates the exact
 * working-copy bytes the preview showed — not a rebuilt Git snapshot — through
 * the same supervised project runner, and returns only supported plain values.
 * Anything not representable is reported as a limitation. The evaluated bytes
 * are recorded so apply can refuse if the configuration changed afterwards.
 */
async function evaluateExecutableProjectConfig(
  repositoryRoot: string,
  projectRoot: string,
  target:
    | { readonly configPath: string }
    | { readonly sharedConfig: string; readonly configPath: string },
  signal: AbortSignal,
): Promise<EvaluatedExecutableImport> {
  signal.throwIfAborted();
  const permit = await requireProjectPrettierTrust(
    repositoryRoot,
    projectRoot,
    true,
  );
  const installation = await resolveProjectPrettierInstallation(
    repositoryRoot,
    projectRoot,
    repositoryRoot,
  );
  const session = await openProjectFormatter({
    checkoutRoot: await realpath(repositoryRoot),
    snapshotRoot: repositoryRoot,
    projectRoot,
    installation,
    permit,
    signal,
  });
  try {
    const imported =
      "sharedConfig" in target
        ? await session.readSharedConfigForImport(target.sharedConfig)
        : await session.readConfigForImport(target.configPath);
    const boundPath = target.configPath;
    const boundBytes = await readFile(join(repositoryRoot, boundPath), "utf8");
    return Object.freeze({
      nativeConfig: imported,
      evaluatedConfig: Object.freeze({
        path: boundPath,
        sha256: createHash("sha256").update(boundBytes, "utf8").digest("hex"),
      }),
    });
  } finally {
    await session.close();
  }
}

interface ExecutableConfigTarget {
  readonly projectRoot: string;
  readonly target:
    | { readonly configPath: string }
    | { readonly sharedConfig: string; readonly configPath: string };
}

export async function evaluateExecutableProjectConfigs(
  repositoryRoot: string,
  base: InitFormattingImport,
  targets: readonly ExecutableConfigTarget[],
  signal: AbortSignal,
): Promise<EvaluatedExecutableImports> {
  const nativeConfigs = new Map<string, ImportableNativeConfig>();
  const evaluatedConfigs: ExecutableEvaluatedConfig[] = [];
  for (const { projectRoot, target } of targets) {
    signal.throwIfAborted();
    const evaluated = await evaluateExecutableProjectConfig(
      repositoryRoot,
      projectRoot,
      target,
      signal,
    );
    nativeConfigs.set(evaluated.evaluatedConfig.path, evaluated.nativeConfig);
    evaluatedConfigs.push(evaluated.evaluatedConfig);
  }
  // Rebuild every inherited EditorConfig scope from its evaluated owner.
  // Real nested Prettier configs still reset inherited Prettier settings.
  const preview = await previewPrettierSettingsImport(
    repositoryRoot,
    nativeConfigs,
  );
  const imported: InitFormattingImport = {
    ...base,
    settings: preview.settings,
    overrides: preview.overrides,
    limitations: preview.limitations,
  };
  return Object.freeze({
    imported,
    evaluatedConfigs: Object.freeze(evaluatedConfigs),
  });
}

export class ProjectPrettierTrustRequiredError extends Error {
  readonly projectRoot: string;
  constructor(projectRoot: string) {
    super(
      `Using the project's Prettier in ${
        projectRoot === "." ? "the repository root" : projectRoot
      } requires explicit trust. Re-run with --trust-project-prettier or interactively.`,
    );
    this.name = "ProjectPrettierTrustRequiredError";
    this.projectRoot = projectRoot;
  }
}
