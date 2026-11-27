import { lefthookFilename } from "./lefthook.js";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { GitClient } from "../git/client.js";
import { isContainedPath } from "../inspection/paths.js";
import { resolveInstalledCliCommand, type ScanHookName } from "./command.js";
import {
  managedHookInvocation,
  installedHookCommand,
} from "./installed-command.js";
import { detectHookChoice } from "./detect.js";
import { readHookData } from "./read-hook-data.js";
import { readHuskyHook, type HuskyHook } from "./husky-state.js";
import {
  delegatesToPreCommit,
  hasZedbeeScanCommand,
  mergeHookCommand,
  managedUpdateReason,
} from "./husky.js";

import {
  managedHookUpdateNotice,
  type ManagedHookUpdateReason,
  HUSKY_ACTIVATION_NOTICE,
  HUSKY_INSTALLATION_NOTICE,
  HUSKY_CUSTOM_RUNTIME_NOTICE,
  SHARED_HUSKY_ACTIVATION_NOTICE,
  type HookUpdateNotice,
} from "../reporting/hook-update-notice.js";
export { HOOK_UPDATE_NOTICE } from "../reporting/hook-update-notice.js";

const contained = isContainedPath;

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
  readonly huskyPreCommit?: Readonly<{ active: boolean; shared: boolean }>;
}

function managedHuskyInvocation(source: string) {
  for (const line of source.split("\n")) {
    const guarded = managedHookInvocation(
      line.trim().replace(/ \|\| exit \$\?$/u, ""),
    );
    if (guarded !== undefined) return guarded;
  }
  return undefined;
}

function resolveHuskyMaintenance(
  hooks: ReadonlyMap<ScanHookName, HuskyHook>,
  command: string | undefined,
  shared: boolean,
  optedOut: boolean,
): Pick<HookMaintenance, "hookUpdate" | "huskyPreCommit"> {
  const preCommit = hooks.get("pre-commit");
  const preCommitConfigured = hasZedbeeScanCommand(
    preCommit?.source ?? "",
    "pre-commit",
  );
  const huskyPreCommit = {
    active: !optedOut && preCommit?.reachable === true && preCommitConfigured,
    shared,
  };
  if (optedOut) return { huskyPreCommit };
  let stale:
    { hook: ScanHookName; reason: ManagedHookUpdateReason } | undefined;
  let missingInstallation = false;
  for (const [name, hook] of hooks) {
    if (hook.source === undefined) continue;
    const configured =
      hasZedbeeScanCommand(hook.source, name) ||
      (name === "pre-merge-commit" &&
        preCommitConfigured &&
        delegatesToPreCommit(hook.source));
    if (!configured) continue;
    if (!hook.reachable)
      return {
        huskyPreCommit,
        hookUpdate:
          hook.verification === "custom"
            ? HUSKY_CUSTOM_RUNTIME_NOTICE
            : shared
              ? SHARED_HUSKY_ACTIVATION_NOTICE
              : HUSKY_ACTIVATION_NOTICE,
      };
    const managed = managedHuskyInvocation(hook.source);
    if (command === undefined) {
      missingInstallation ||= managed !== undefined;
    } else {
      const reason = managedUpdateReason(hook.source, command, name);
      if (stale === undefined && reason !== undefined)
        stale = { hook: name, reason };
    }
  }
  return {
    huskyPreCommit,
    ...(missingInstallation
      ? { hookUpdate: HUSKY_INSTALLATION_NOTICE }
      : stale
        ? {
            hookUpdate: managedHookUpdateNotice(
              stale.hook,
              stale.reason,
              shared,
            ),
          }
        : {}),
  };
}

/** Share installation selection and bounded hook inspection across scan and doctor. */
export async function inspectHookMaintenance(
  repositoryRoot: string,
  huskyOptedOut = process.env.HUSKY === "0",
): Promise<HookMaintenance> {
  const installedCliCommand = await resolveInstalledCliCommand(
    repositoryRoot,
  ).catch(() => undefined);
  const result =
    installedCliCommand === undefined ? {} : { installedCliCommand };

  try {
    const root = await realpath(repositoryRoot);
    const command =
      installedCliCommand === undefined
        ? undefined
        : installedHookCommand(installedCliCommand[1]!);
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
    const localHusky = new Map<ScanHookName, HuskyHook>();
    const sharedHusky = new Map<ScanHookName, HuskyHook>();
    for (const [index, hook] of hookResults.entries()) {
      const name = hookNames[index]!;
      const path = resolve(root, hook.stdout);
      if (contained(root, path) || contained(join(common, "hooks"), path))
        scripts.add(path);
      const local = await readHuskyHook(root, path, name);
      if (local !== undefined) localHusky.set(name, local);
      if (sharedOwner !== undefined) {
        const shared = await readHuskyHook(sharedOwner, path, name);
        if (shared !== undefined) sharedHusky.set(name, shared);
      }
    }
    if (sharedHusky.size > 0)
      return {
        ...result,
        ...resolveHuskyMaintenance(sharedHusky, command, true, huskyOptedOut),
      };
    if (localHusky.size > 0)
      return {
        ...result,
        ...resolveHuskyMaintenance(localHusky, command, false, huskyOptedOut),
      };
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
      const preCommit = await readHookData(join(root, ".husky/pre-commit"));
      const effectivePath = resolve(root, hookResults[0]!.stdout);
      const effectiveHook = scripts.has(effectivePath)
        ? await readHookData(effectivePath, true)
        : undefined;
      if (
        preCommit !== undefined &&
        hasZedbeeScanCommand(preCommit, "pre-commit") &&
        !hasZedbeeScanCommand(effectiveHook ?? "", "pre-commit")
      )
        return {
          ...result,
          huskyPreCommit: { active: false, shared: false },
          ...(huskyOptedOut ? {} : { hookUpdate: HUSKY_ACTIVATION_NOTICE }),
        };
    }
    if (command === undefined) return result;
    const sources = await Promise.all(
      [...scripts].map((path) => readHookData(path)),
    );
    let managerSources: readonly string[] = [];
    if (choice === "simple-git-hooks" && managers[0] !== undefined) {
      managerSources = managerCommands(managers[0], false);
    } else if (choice === "lefthook") {
      // Match init's filename precedence, including an unreadable preferred file.
      const source =
        managers[(await lefthookFilename(root)) === "lefthook.yaml" ? 2 : 1];
      if (source !== undefined) managerSources = managerCommands(source, true);
    }
    for (const [source, layout] of [
      ...sources
        .filter((source): source is string => source !== undefined)
        .map((source) => [source, true] as const),
      ...managerSources.map(
        (source) => [source, choice !== "lefthook"] as const,
      ),
    ]) {
      const hook = hasZedbeeScanCommand(source, "pre-merge-commit")
        ? "pre-merge-commit"
        : "pre-commit";
      const reason = managedUpdateReason(source, command, hook, layout);
      if (reason !== undefined)
        return { ...result, hookUpdate: managedHookUpdateNotice(hook, reason) };
    }
    return result;
  } catch {
    // Setup advice must never change analysis outcomes or prevent a scan.
    return result;
  }
}
