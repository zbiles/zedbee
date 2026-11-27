import { realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { execa } from "execa";
import { installArguments, installDependency } from "./install-dependency.mjs";
import { ZEDBEE_VERSION } from "../core/package-version.js";
import { captureWorkingTreeRegistry } from "../inspection/working-tree-registry.js";
import { discoverWorkspaces } from "../inspection/workspaces.js";
import { resolveHookCommand } from "../hooks/command.js";
import { isContainedPath } from "../inspection/paths.js";
import { discoverProjectPrettierInRegistry } from "./prettier-discovery.js";
import { LOCKFILE_MANAGERS } from "../inspection/inspect-repository.js";

export interface ProjectInstallTarget {
  readonly projectRoot: string;
  readonly manager: "npm" | "pnpm" | "yarn" | "bun";
  readonly args: readonly string[];
  readonly hasPrettier: boolean;
  readonly workspaceRoot?: boolean;
}

const LOCKFILES = Object.entries(LOCKFILE_MANAGERS) as readonly (readonly [
  string,
  ProjectInstallTarget["manager"],
])[];

export async function projectInstallTargets(
  repositoryRoot: string,
  projectRoots: readonly string[],
): Promise<readonly ProjectInstallTarget[]> {
  const registry = await captureWorkingTreeRegistry(repositoryRoot);
  const canonicalRoot = await realpath(repositoryRoot);
  const [projects, prettier] = await Promise.all([
    discoverWorkspaces(registry),
    discoverProjectPrettierInRegistry(registry, canonicalRoot),
  ]);
  const paths = new Set(
    registry.entries().map((entry) => entry.repositoryPath),
  );
  const manifests = new Map(
    projects.map((project) => [project.relativeRoot, project.manifest]),
  );
  return projects
    .filter((project) => projectRoots.includes(project.relativeRoot))
    .map((project) => {
      let manager: ProjectInstallTarget["manager"] = "npm";
      let classicYarn = false;
      let directory = project.relativeRoot;
      while (true) {
        const manifest = manifests.get(directory);
        const declared = /^(npm|pnpm|yarn|bun)@/u.exec(
          manifest?.packageManager ?? "",
        )?.[1];
        const lock = LOCKFILES.find(([filename]) =>
          paths.has(posix.join(directory, filename)),
        );
        if (declared !== undefined || lock !== undefined) {
          manager = (declared ?? lock![1]) as ProjectInstallTarget["manager"];
          classicYarn =
            manifest?.packageManager?.startsWith("yarn@1.") === true;
          break;
        }
        if (directory === ".") break;
        directory = posix.dirname(directory);
      }
      const workspaceRoot =
        project.relativeRoot === "." &&
        (project.manifest.workspacePatterns.length > 0 ||
          paths.has("pnpm-workspace.yaml"));
      const args = installArguments(
        manager,
        workspaceRoot,
        classicYarn,
        `zedbee@${ZEDBEE_VERSION}`,
      );
      return {
        projectRoot: project.relativeRoot,
        manager,
        args,
        workspaceRoot,
        hasPrettier: prettier.some(
          (found) =>
            found.projectRoot === project.relativeRoot &&
            (found.declaredRange !== undefined || found.configPaths.length > 0),
        ),
      };
    });
}

export async function installProjectDependency(
  repositoryRoot: string,
  target: ProjectInstallTarget,
  signal: AbortSignal,
): Promise<void> {
  const root = await realpath(repositoryRoot);
  const cwd = await realpath(join(root, target.projectRoot));
  if (!isContainedPath(root, cwd)) {
    throw new Error("The selected project folder leaves this repository.");
  }
  const current = (await projectInstallTargets(root, [target.projectRoot]))[0];
  if (current === undefined)
    throw new Error("The selected project folder is no longer available.");
  await installDependency(
    {
      manager: current.manager,
      cwd,
      packageSpec: `zedbee@${ZEDBEE_VERSION}`,
      workspaceRoot: current.workspaceRoot === true,
      signal,
    },
    (command, args, { cancelSignal, ...options }) =>
      execa(command, args, {
        ...options,
        ...(cancelSignal === undefined ? {} : { cancelSignal }),
      }),
  );
  await resolveHookCommand(root);
}
