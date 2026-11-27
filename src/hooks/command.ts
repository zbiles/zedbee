import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { compareCodeUnits } from "../core/compare.js";
import { isContainedPath } from "../inspection/read-json.js";
import { captureWorkingTreeRegistry } from "../inspection/working-tree-registry.js";
import { discoverWorkspaces } from "../inspection/workspaces.js";

import { installedHookCommand } from "./installed-command.js";

export type ScanHookName = "pre-commit" | "pre-merge-commit";

export const SCAN_HOOK_NAMES = Object.freeze([
  "pre-commit",
  "pre-merge-commit",
] as const);

export class HookInstallationError extends Error {
  constructor(
    message: string,
    readonly projectRoots: readonly string[] = [],
  ) {
    super(message);
  }
}

/** Read installed package metadata only; never execute packages during setup. */
async function installedCommand(
  repositoryRoot: string,
  projectRoot: string,
  hookName: ScanHookName = "pre-commit",
): Promise<
  { command: string; packageRoot: string; cliPath: string } | undefined
> {
  let directory = resolve(repositoryRoot, projectRoot);
  while (isContainedPath(repositoryRoot, directory)) {
    const packageRoot = join(directory, "node_modules", "zedbee");
    try {
      const manifestPath = join(packageRoot, "package.json");
      const metadata = await stat(manifestPath);
      if (!metadata.isFile() || metadata.size > 1024 * 1024) return undefined;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        name?: unknown;
        bin?: string | { zedbee?: unknown };
      };
      const bin =
        typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.zedbee;
      if (manifest.name !== "zedbee" || typeof bin !== "string")
        return undefined;
      const path = resolve(packageRoot, bin);
      if (!isContainedPath(packageRoot, path) || !(await stat(path)).isFile())
        return undefined;
      const canonicalPackage = await realpath(packageRoot);
      if (!isContainedPath(canonicalPackage, await realpath(path)))
        return undefined;
      const repositoryPath = `./${relative(repositoryRoot, path).split(sep).join("/")}`;
      if (/[\r\n\0]/u.test(repositoryPath)) return undefined;
      return {
        command: installedHookCommand(repositoryPath, hookName),
        packageRoot,
        cliPath: repositoryPath,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    if (directory === repositoryRoot) break;
    directory = dirname(directory);
  }
  return undefined;
}

async function installationCandidates(repositoryRoot: string) {
  const root = await realpath(repositoryRoot);
  const projects = await discoverWorkspaces(
    await captureWorkingTreeRegistry(root),
  );
  const declared = projects.filter((project) =>
    project.manifest.dependencyNames.has("zedbee"),
  );
  // Prefer the repository root, then stable discovery order. Any selected copy
  // remains repository-relative so the hook also works in clones/worktrees.
  declared.sort((a, b) =>
    a.relativeRoot === "."
      ? -1
      : b.relativeRoot === "."
        ? 1
        : compareCodeUnits(a.relativeRoot, b.relativeRoot),
  );
  return { root, projects, declared };
}

async function firstInstallation(
  root: string,
  declared: ReadonlyArray<{ readonly relativeRoot: string }>,
  hookName: ScanHookName = "pre-commit",
): Promise<Awaited<ReturnType<typeof installedCommand>>> {
  for (const project of declared) {
    const installation = await installedCommand(
      root,
      project.relativeRoot,
      hookName,
    );
    if (installation !== undefined) return installation;
  }
  return undefined;
}

export async function resolveHookCommand(
  repositoryRoot: string,
  hookName: ScanHookName = "pre-commit",
): Promise<string> {
  const { root, projects, declared } =
    await installationCandidates(repositoryRoot);
  const installation = await firstInstallation(root, declared, hookName);
  if (installation !== undefined) return installation.command;
  const candidates = declared.length > 0 ? declared : projects;
  const location =
    candidates.length === 0
      ? "the repository root"
      : candidates.length === 1
        ? candidates[0]!.relativeRoot === "."
          ? "the repository root"
          : candidates[0]!.relativeRoot
        : `one of these project folders: ${candidates.map((project) => project.relativeRoot).join(", ")}`;
  throw new HookInstallationError(
    `No usable project installation of Zedbee was found. Install zedbee as a development dependency in ${location}, then rerun zedbee init. Use --hook none to configure checks without installing a hook.`,
    candidates.map((project) => project.relativeRoot),
  );
}

/** Same declared, validated installation and preference order used by hooks. */
export async function resolveInstalledCliCommand(
  repositoryRoot: string,
): Promise<readonly string[] | undefined> {
  const { root, declared } = await installationCandidates(repositoryRoot);
  const installation = await firstInstallation(root, declared);
  return installation === undefined
    ? undefined
    : Object.freeze(["node", installation.cliPath]);
}

/** Resolve the schema beside the same declared installation used for hooks. */
export async function resolveLocalSchemaReference(
  repositoryRoot: string,
): Promise<string | undefined> {
  const { root, declared } = await installationCandidates(repositoryRoot);
  const installation = await firstInstallation(root, declared);
  if (installation === undefined) return undefined;
  const schema = join(installation.packageRoot, "schema", "zedbee.schema.json");
  try {
    if (
      !(await stat(schema)).isFile() ||
      !isContainedPath(
        await realpath(installation.packageRoot),
        await realpath(schema),
      )
    )
      return undefined;
    return `./${relative(root, schema).split(sep).join("/")}`;
  } catch {
    return undefined;
  }
}
