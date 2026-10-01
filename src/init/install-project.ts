import { realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { execa } from "execa";
import { ZEDBEE_VERSION } from "../core/package-version.js";
import { captureWorkingTreeRegistry } from "../inspection/working-tree-registry.js";
import { discoverWorkspaces } from "../inspection/workspaces.js";
import { resolveHookCommand } from "../hooks/command.js";
import { discoverProjectPrettier } from "./prettier-discovery.js";

export interface ProjectInstallTarget {
  readonly projectRoot: string;
  readonly manager: "npm" | "pnpm" | "yarn" | "bun";
  readonly args: readonly string[];
  readonly hasPrettier: boolean;
}

const LOCKFILES = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
] as const;

export async function projectInstallTargets(
  repositoryRoot: string,
  projectRoots: readonly string[],
): Promise<readonly ProjectInstallTarget[]> {
  const registry = await captureWorkingTreeRegistry(repositoryRoot);
  const [projects, prettier] = await Promise.all([
    discoverWorkspaces(registry),
    discoverProjectPrettier(repositoryRoot),
  ]);
  const paths = new Set(
    registry.entries().map((entry) => entry.repositoryPath),
  );
  return projects
    .filter((project) => projectRoots.includes(project.relativeRoot))
    .map((project) => {
      let manager: ProjectInstallTarget["manager"] = "npm";
      let classicYarn = false;
      let directory = project.relativeRoot;
      while (true) {
        const manifest = projects.find(
          (candidate) => candidate.relativeRoot === directory,
        )?.manifest;
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
      const args =
        manager === "npm" || manager === "pnpm"
          ? [
              manager === "npm" ? "install" : "add",
              "--save-dev",
              "--save-exact",
            ]
          : [
              "add",
              "--dev",
              "--exact",
              ...(workspaceRoot && manager === "yarn" && classicYarn
                ? ["--ignore-workspace-root-check"]
                : []),
            ];
      if (workspaceRoot && manager === "pnpm") {
        args.splice(1, 0, "--workspace-root");
      }
      args.push(`zedbee@${ZEDBEE_VERSION}`);
      return {
        projectRoot: project.relativeRoot,
        manager,
        args,
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
  const path = relative(root, cwd);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("The selected project folder leaves this repository.");
  }
  const current = (await projectInstallTargets(root, [target.projectRoot]))[0];
  if (current === undefined)
    throw new Error("The selected project folder is no longer available.");
  const result = await execa(current.manager, [...current.args], {
    cwd,
    cancelSignal: signal,
    killDescendants: true,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    stdin: "ignore",
    reject: false,
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-800);
    throw new Error(
      detail ||
        "Zedbee installation failed. Check your package manager and registry access.",
    );
  }
  await resolveHookCommand(root);
}
