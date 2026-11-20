import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { GitClient } from "../git/client.js";
import { resolveHookCommand } from "./command.js";
import { detectHookChoice } from "./detect.js";
import { mergeHookCommand, replaceManagedZedbeeCommand } from "./husky.js";

import {
  HOOK_UPDATE_NOTICE,
  type HookUpdateNotice,
} from "../reporting/hook-update-notice.js";
export { HOOK_UPDATE_NOTICE } from "../reporting/hook-update-notice.js";

const MAX_BYTES = 64 * 1024;

function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`);
}

/** Optional, bounded, data-only reads. Never follow a hook symlink. */
async function readHookData(path: string): Promise<string | undefined> {
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
      if (!state.isFile() || state.size > MAX_BYTES) return undefined;
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

/** The same managed-command recognition as init; no version or timestamp guess. */
export async function getHookUpdateNotice(
  repositoryRoot: string,
  hookCommand?: string,
): Promise<HookUpdateNotice | undefined> {
  try {
    const root = await realpath(repositoryRoot);
    const command = hookCommand ?? (await resolveHookCommand(root));
    const git = new GitClient(root);
    const [commonResult, ...hookResults] = await Promise.all([
      git.run(["rev-parse", "--git-common-dir"]),
      git.run(["rev-parse", "--git-path", "hooks/pre-commit"]),
      git.run(["rev-parse", "--git-path", "hooks/pre-merge-commit"]),
    ]);
    const common = await realpath(resolve(root, commonResult.stdout));
    const scripts = new Set<string>();
    for (const result of hookResults) {
      const path = resolve(root, result.stdout);
      if (contained(root, path) || contained(join(common, "hooks"), path))
        scripts.add(path);
      // Husky's generated dispatcher delegates to its tracked sibling scripts.
      if (
        path ===
        join(
          root,
          ".husky/_",
          path.endsWith("pre-merge-commit") ? "pre-merge-commit" : "pre-commit",
        )
      ) {
        scripts.add(
          join(
            root,
            ".husky",
            path.endsWith("pre-merge-commit")
              ? "pre-merge-commit"
              : "pre-commit",
          ),
        );
      }
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
    if (choice === "none") return undefined;
    if (choice === "husky") {
      scripts.add(join(root, ".husky/pre-commit"));
      scripts.add(join(root, ".husky/pre-merge-commit"));
    }
    const sources = await Promise.all([...scripts].map(readHookData));
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
    for (const source of commands) {
      // Evaluate one hook kind at a time so an up-to-date merge command does
      // not look stale merely because its arguments differ from pre-commit.
      for (const line of source.split("\n")) {
        const value = line.trim();
        const desired = /(?:^|\s)--merge(?:\s|\)|$)/u.test(value)
          ? mergeHookCommand(command)
          : command;
        if (replaceManagedZedbeeCommand(value, desired) !== value)
          return HOOK_UPDATE_NOTICE;
      }
    }
    return undefined;
  } catch {
    // Setup advice must never change analysis outcomes or prevent a scan.
    return undefined;
  }
}
