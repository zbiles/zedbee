import { launchBackgroundNode } from "../runtime/background-node.js";
import { relative, isAbsolute, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { GitClient } from "../git/client.js";
import { captureWorkingTreeRegistry } from "../inspection/working-tree-registry.js";
import { discoverWorkspaces } from "../inspection/workspaces.js";
import { owningWorkspace } from "../inspection/workspace-owner.js";
import { projectInstallManager } from "../init/install-project.js";
import { terminalText } from "../renderers/terminal-style.js";
import {
  isUpdateCacheFresh,
  readUpdateCache,
  UPDATE_MAX_AGE,
  updateCachePath,
} from "./cache.js";
import { updateFromMetadata, type UpdateNotice } from "./metadata.js";

type Environment = Readonly<Record<string, string | undefined>>;

function scheduleRefresh(env: Environment): void {
  launchBackgroundNode(new URL("./worker.js", import.meta.url), env);
}

export function getUpdateNotice(options: {
  env: Environment;
  isTTY: boolean;
  format: string;
  currentVersion: string;
  nodeVersion: string;
  now?: number;
  refresh?: () => void;
}): UpdateNotice | undefined {
  const { env, isTTY, format } = options;
  if (
    !isTTY ||
    env.CI !== undefined ||
    env.ZEDBEE_NO_UPDATE_CHECK === "1" ||
    env.NO_UPDATE_NOTIFIER !== undefined ||
    format === "json" ||
    format === "sarif"
  )
    return undefined;
  try {
    const now = options.now ?? Date.now();
    const cache = readUpdateCache(updateCachePath(env), now);
    if (!isUpdateCacheFresh(cache, now)) {
      try {
        (options.refresh ?? (() => scheduleRefresh(env)))();
      } catch {
        /* Optional. */
      }
    }
    if (cache === undefined || now - cache.checkedAt > UPDATE_MAX_AGE)
      return undefined;
    return updateFromMetadata(
      cache.metadata,
      options.currentVersion,
      options.nodeVersion,
    );
  } catch {
    return undefined;
  }
}

const COMMANDS = {
  npm: "npm install --save-dev zedbee@latest",
  pnpm: "pnpm add --save-dev zedbee@latest",
  yarn: "yarn add --dev zedbee@latest",
  bun: "bun add --dev zedbee@latest",
} as const;

/** Resolve the declared dependency's owner only when an update is displayed. */
export async function updateCommand(cwd: string): Promise<string> {
  try {
    const root = await realpath(
      (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"])).stdout,
    );
    const registry = await captureWorkingTreeRegistry(root);
    const projects = await discoverWorkspaces(registry);
    const declared = projects.filter(({ manifest }) =>
      manifest.dependencyNames.has("zedbee"),
    );
    const location =
      relative(root, await realpath(cwd))
        .split(sep)
        .join("/") || ".";
    if (isAbsolute(location) || location === ".." || location.startsWith("../"))
      throw new Error("outside checkout");
    const project =
      owningWorkspace(declared, `${location}/`) ??
      (declared.length === 1 ? declared[0] : undefined);
    if (project === undefined) {
      return declared.length === 0
        ? "Update your existing installation of zedbee using the package manager that installed it (no declared project dependency found)."
        : "Multiple projects declare zedbee; update the intended project dependency from its own package directory.";
    }
    const paths = new Set(
      registry.entries().map(({ repositoryPath }) => repositoryPath),
    );
    const { manager, workspaceRoot } = projectInstallManager(
      project,
      projects,
      paths,
    );
    const command =
      manager === "pnpm" && workspaceRoot
        ? "pnpm add --save-dev --workspace-root zedbee@latest"
        : COMMANDS[manager];
    return `In repository directory ${JSON.stringify(project.relativeRoot)}: ${command}`;
  } catch {
    return "Update your existing installation of zedbee using the package manager that installed it (project owner unavailable).";
  }
}

export async function renderUpdateNotice(
  notice: UpdateNotice,
  options: { cwd: string; color: boolean; indent?: boolean },
): Promise<string> {
  const indent = options.indent === true ? " " : "";
  return `\n${indent}${terminalText("UPDATE AVAILABLE", "warning", options.color)}\n${indent}Zedbee ${notice.current} → ${notice.latest}\n${indent}${await updateCommand(options.cwd)}\n`;
}
