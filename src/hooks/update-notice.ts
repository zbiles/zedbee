import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseDocument } from "yaml";
import { GitClient } from "../git/client.js";
import { resolveInstalledCliCommand } from "./command.js";
import { installedHookCommand } from "./installed-command.js";
import { detectHookChoice } from "./detect.js";
import { hasHookExecutePermission } from "./install.js";
import {
  hasZedbeeScanCommand,
  mergeHookCommand,
  replaceManagedZedbeeCommand,
} from "./husky.js";

import {
  HOOK_UPDATE_NOTICE,
  SHARED_HUSKY_UPDATE_NOTICE,
  type HookUpdateNotice,
} from "../reporting/hook-update-notice.js";
export { HOOK_UPDATE_NOTICE } from "../reporting/hook-update-notice.js";

const MAX_BYTES = 64 * 1024;

function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`);
}

/** Optional, bounded, data-only reads. Never follow a hook symlink. */
async function readHookData(
  path: string,
  requireExecutable = false,
): Promise<string | undefined> {
  try {
    if ((await realpath(path)) !== path) return undefined;
    const before = await lstat(path);
    if (!before.isFile() || before.size > MAX_BYTES) return undefined;
    const file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const state = await file.stat();
      if (
        !state.isFile() ||
        state.size > MAX_BYTES ||
        (requireExecutable && !hasHookExecutePermission(state.mode))
      )
        return undefined;
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (read.bytesRead === 0) return bytes.toString("utf8", 0, length);
        length += read.bytesRead;
      }
      return undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function managerCommands(source: string, yaml: boolean): readonly string[] {
  try {
    const document = yaml ? parseDocument(source, { strict: true }) : undefined;
    if (document !== undefined && document.errors.length > 0) return [];
    const data = record(
      document === undefined
        ? JSON.parse(source)
        : document.toJS({ maxAliasCount: 0 }),
    );
    const hooks = yaml ? data : record(data["simple-git-hooks"]);
    return ["pre-commit", "pre-merge-commit"].flatMap((name) => {
      if (!yaml)
        return typeof hooks[name] === "string" ? [hooks[name] as string] : [];
      return Object.values(record(record(hooks[name]).commands))
        .map((entry) => record(entry).run)
        .filter((run): run is string => typeof run === "string");
    });
  } catch {
    return [];
  }
}

interface HookMaintenance {
  readonly installedCliCommand?: readonly string[];
  readonly hookUpdate?: HookUpdateNotice;
  readonly sharedHuskyPreCommit?: boolean;
}

function needsManagedUpdate(source: string, command: string): boolean {
  // Check each hook kind against its own command, including its merge flags.
  return source.split("\n").some((line) => {
    const value = line.trim();
    const expected = /(?:^|\s)--merge(?:\s|\)|$)/u.test(value)
      ? mergeHookCommand(command)
      : command;
    return replaceManagedZedbeeCommand(value, expected) !== value;
  });
}

/** Share installation selection and bounded hook inspection across scan and doctor. */
export async function inspectHookMaintenance(
  repositoryRoot: string,
): Promise<HookMaintenance> {
  const installedCliCommand = await resolveInstalledCliCommand(
    repositoryRoot,
  ).catch(() => undefined);
  if (installedCliCommand === undefined) return {};
  const result = { installedCliCommand };

  try {
    const root = await realpath(repositoryRoot);
    const command = installedHookCommand(installedCliCommand[1]!);
    const git = new GitClient(root);
    const hookNames = ["pre-commit", "pre-merge-commit"] as const;
    const [gitDirs, ...hookResults] = await Promise.all([
      git.run(["rev-parse", "--git-common-dir", "--absolute-git-dir"]),
      ...hookNames.map((name) =>
        git.run(["rev-parse", "--git-path", `hooks/${name}`]),
      ),
    ]);
    const [commonPath, checkoutGitPath] = gitDirs.stdout.split(/\r?\n/u);
    const common = await realpath(resolve(root, commonPath!));
    const mainCheckout = dirname(common);
    const sharedOwner =
      basename(common) === ".git" &&
      mainCheckout !== root &&
      dirname(await realpath(resolve(root, checkoutGitPath!))) ===
        join(common, "worktrees")
        ? mainCheckout
        : undefined;
    const scripts = new Set<string>();
    const sharedScripts = new Map<(typeof hookNames)[number], string>();
    for (const [index, hook] of hookResults.entries()) {
      const name = hookNames[index]!;
      const path = resolve(root, hook.stdout);
      if (contained(root, path) || contained(join(common, "hooks"), path))
        scripts.add(path);
      // Husky 9's dispatcher delegates to its tracked sibling script, even
      // when core.hooksPath points from a linked worktree to the main checkout.
      if (path === join(root, ".husky", "_", name))
        scripts.add(join(root, ".husky", name));
      if (
        sharedOwner !== undefined &&
        path === join(sharedOwner, ".husky", "_", name)
      ) {
        const [dispatcher, handler] = await Promise.all([
          readHookData(path, true),
          readHookData(join(sharedOwner, ".husky", "_", "h")),
        ]);
        if (
          dispatcher?.split(/\r?\n/u).includes('. "$(dirname "$0")/h"') &&
          handler !== undefined
        ) {
          const source = await readHookData(join(sharedOwner, ".husky", name));
          sharedScripts.set(name, source ?? "");
        }
      }
    }
    if (sharedScripts.size > 0) {
      const preCommit = sharedScripts.get("pre-commit");
      return {
        ...result,
        ...(preCommit === undefined
          ? {}
          : {
              sharedHuskyPreCommit: hasZedbeeScanCommand(
                preCommit,
                "pre-commit",
              ),
            }),
        ...([...sharedScripts.values()].some((source) =>
          needsManagedUpdate(source, command),
        )
          ? { hookUpdate: SHARED_HUSKY_UPDATE_NOTICE }
          : {}),
      };
    }
    const managers = await Promise.all(
      ["package.json", "lefthook.yml", "lefthook.yaml"].map((name) =>
        readHookData(join(root, name)),
      ),
    );
    const choice = await detectHookChoice(root, {
      manifest:
        managers[0] === undefined ? undefined : record(JSON.parse(managers[0])),
    });
    if (choice === "none") return result;
    if (choice === "husky") {
      scripts.add(join(root, ".husky/pre-commit"));
      scripts.add(join(root, ".husky/pre-merge-commit"));
    }
    const sources = await Promise.all([...scripts].map((path) => readHookData(path)));
    let managerSources: readonly string[] = [];
    if (choice === "simple-git-hooks" && managers[0] !== undefined) {
      managerSources = managerCommands(managers[0], false);
    } else if (choice === "lefthook") {
      // Match init's filename precedence, including an unreadable preferred file.
      const preferredYaml = await lstat(join(root, "lefthook.yaml")).then(
        () => true,
        () => false,
      );
      const source = managers[preferredYaml ? 2 : 1];
      if (source !== undefined) managerSources = managerCommands(source, true);
    }
    const commands = [
      ...sources.filter((source): source is string => source !== undefined),
      ...managerSources,
    ];
    return commands.some((source) => needsManagedUpdate(source, command))
      ? { ...result, hookUpdate: HOOK_UPDATE_NOTICE }
      : result;
  } catch {
    // Setup advice must never change analysis outcomes or prevent a scan.
    return result;
  }
}
