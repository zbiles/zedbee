import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalText } from "../renderers/terminal-style.js";
import {
  readUpdateCache,
  UPDATE_INTERVAL,
  UPDATE_MAX_AGE,
  updateCachePath,
} from "./cache.js";
import { updateFromMetadata, type UpdateNotice } from "./metadata.js";

type Environment = Readonly<Record<string, string | undefined>>;

function scheduleRefresh(env: Environment): void {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./worker.js", import.meta.url))],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...env },
    },
  );
  child.on("error", () => {});
  child.unref();
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
    if (cache === undefined || now - cache.checkedAt >= UPDATE_INTERVAL) {
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

function commandFor(manager: keyof typeof COMMANDS, directory: string): string {
  if (
    manager === "pnpm" &&
    existsSync(join(directory, "pnpm-workspace.yaml"))
  ) {
    return "pnpm add --save-dev --workspace-root zedbee@latest";
  }
  return COMMANDS[manager];
}

export function updateCommand(cwd: string): string {
  let directory = resolve(cwd);
  while (true) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as { packageManager?: unknown };
      const manager =
        typeof manifest.packageManager === "string"
          ? /^(npm|pnpm|yarn|bun)@/.exec(manifest.packageManager)?.[1]
          : undefined;
      if (manager !== undefined)
        return commandFor(manager as keyof typeof COMMANDS, directory);
    } catch {
      /* Fall back to lockfiles or a workspace ancestor. */
    }
    for (const [file, manager] of [
      ["package-lock.json", "npm"],
      ["npm-shrinkwrap.json", "npm"],
      ["pnpm-lock.yaml", "pnpm"],
      ["pnpm-workspace.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
    ] as const) {
      if (existsSync(join(directory, file)))
        return commandFor(manager, directory);
    }
    const parent = dirname(directory);
    if (parent === directory || existsSync(join(directory, ".git")))
      return COMMANDS.npm;
    directory = parent;
  }
}

export function renderUpdateNotice(
  notice: UpdateNotice,
  options: { cwd: string; color: boolean; indent?: boolean },
): string {
  const indent = options.indent === true ? " " : "";
  return `\n${indent}${terminalText("UPDATE AVAILABLE", "warning", options.color)}\n${indent}Zedbee ${notice.current} → ${notice.latest}\n${indent}Run: ${updateCommand(options.cwd)}\n`;
}
