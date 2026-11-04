import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  readonly workspaceRoot?: boolean;
}

function installArguments(
  manager: ProjectInstallTarget["manager"],
  workspaceRoot: boolean,
  classicYarn: boolean,
): string[] {
  if (manager === "npm")
    return [
      "install",
      "--save-dev",
      "--save-exact",
      "--ignore-scripts",
      `zedbee@${ZEDBEE_VERSION}`,
    ];
  if (manager === "pnpm")
    return [
      "add",
      ...(workspaceRoot ? ["--workspace-root"] : []),
      "--save-dev",
      "--save-exact",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--manage-package-manager-versions=false",
      `zedbee@${ZEDBEE_VERSION}`,
    ];
  return [
    "add",
    "--dev",
    "--exact",
    ...(manager === "yarn"
      ? classicYarn
        ? [
            "--ignore-scripts",
            "--no-default-rc",
            ...(workspaceRoot ? ["--ignore-workspace-root-check"] : []),
          ]
        : ["--mode=skip-build"]
      : ["--ignore-scripts"]),
    `zedbee@${ZEDBEE_VERSION}`,
  ];
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
      const args = installArguments(manager, workspaceRoot, classicYarn);
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
  const path = relative(root, cwd);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("The selected project folder leaves this repository.");
  }
  const current = (await projectInstallTargets(root, [target.projectRoot]))[0];
  if (current === undefined)
    throw new Error("The selected project folder is no longer available.");
  const env = {
    // Never delegate to a repository-specified package-manager executable.
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    npm_config_ignore_scripts: "true",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    YARN_IGNORE_PATH: "1",
    // Modern Yarn loads plugins from its rc before running any command. Use an
    // unpredictable absent filename rather than loading project configuration.
    YARN_RC_FILENAME: `.zedbee-${randomUUID()}.yarnrc.yml`,
    YARN_ENABLE_SCRIPTS: "false",
    // The hook resolver requires a physical local CLI; disabling project rc
    // must not switch a node_modules installation to Yarn's default PnP.
    YARN_NODE_LINKER: "node-modules",
  };
  let args = [...current.args];
  if (current.manager === "yarn") {
    // A lockfile or packageManager declaration cannot prove which installed
    // Yarn will run. Classic silently accepts some unsupported flags, so probe
    // outside the repository before choosing the script-suppression strategy.
    const probeRoot = await mkdtemp(join(tmpdir(), "zedbee-yarn-version-"));
    try {
      const version = await execa("yarn", ["--version"], {
        cwd: probeRoot,
        env,
        cancelSignal: signal,
        timeout: 30_000,
        stdin: "ignore",
        reject: false,
      });
      const major = /^(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/u.exec(
        version.stdout.trim(),
      )?.[1];
      if (version.exitCode !== 0 || major === undefined || Number(major) < 1)
        throw new Error(
          "Could not identify a supported Yarn version for a script-free installation.",
        );
      if (major === "2")
        throw new Error(
          "Yarn 2 cannot safely add this dependency without workspace builds. Use Yarn 1 or Yarn 3 and newer for automatic installation.",
        );
      args = installArguments(
        "yarn",
        current.workspaceRoot === true,
        major === "1",
      );
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
  }
  const result = await execa(current.manager, args, {
    cwd,
    env,
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
