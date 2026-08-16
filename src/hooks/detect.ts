import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { GitClient } from "../git/client.js";
import { initFileChange } from "../init/recommend.js";
import type {
  InitFileChange,
  InitHookActivation,
  InitHookChoice,
  ResolvedHookChoice,
} from "../init/types.js";
import { hasZedbeeScanCommand, updateHuskyHook } from "./husky.js";
import { updateLefthookConfig } from "./lefthook.js";
import { updateRawGitHook } from "./raw-git.js";
import { updateSimpleGitHooksManifest } from "./simple-git-hooks.js";
import { hasLefthookRunCommand } from "./state.js";

export interface DetectedHookIntegration {
  readonly hook: ResolvedHookChoice;
  readonly change?: InitFileChange;
  readonly activation: InitHookActivation;
}

const ACTIVE_DIRECT = (hook: ResolvedHookChoice): InitHookActivation =>
  Object.freeze({
    status: "active",
    message: `The proposed ${hook} hook directly invokes Zedbee.`,
  });

function pendingManager(hook: "lefthook" | "simple-git-hooks") {
  return hook === "lefthook"
    ? Object.freeze({
        status: "pending" as const,
        message:
          "Lefthook configuration will invoke Zedbee, but initialization cannot safely activate its Git hook without running project tooling.",
        remediation:
          "After reviewing the project tooling, run lefthook install to activate the configured hook.",
      })
    : Object.freeze({
        status: "pending" as const,
        message:
          "simple-git-hooks configuration will invoke Zedbee, but initialization cannot safely activate its Git hook without running project tooling.",
        remediation:
          "After reviewing the project tooling, run npx --no-install simple-git-hooks to activate the configured hook.",
      });
}

async function managerActivation(
  root: string,
  hook: "lefthook" | "simple-git-hooks",
): Promise<InitHookActivation> {
  try {
    const installed = await existingAbsoluteFile(await rawGitHookPath(root));
    const active =
      installed !== undefined &&
      (hook === "lefthook"
        ? hasLefthookRunCommand(installed.contents)
        : hasZedbeeScanCommand(installed.contents));
    if (active) {
      return Object.freeze({
        status: "active",
        message: `The active ${hook} Git hook will invoke the proposed Zedbee command.`,
      });
    }
  } catch {
    // A manager config can still be proposed, but activation stays explicit.
  }
  return pendingManager(hook);
}

interface ExistingFile {
  readonly contents: string;
  readonly mode: number;
}

async function existingFile(
  root: string,
  relativePath: string,
): Promise<ExistingFile | undefined> {
  const path = join(root, relativePath);
  try {
    const state = await lstat(path);
    if (state.isSymbolicLink() || !state.isFile()) {
      throw new Error("Zedbee refused an unsafe hook target.");
    }
    return { contents: await readFile(path, "utf8"), mode: state.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function existingAbsoluteFile(
  path: string,
): Promise<ExistingFile | undefined> {
  try {
    const state = await lstat(path);
    if (state.isSymbolicLink() || !state.isFile()) {
      throw new Error("Zedbee refused an unsafe hook target.");
    }
    return { contents: await readFile(path, "utf8"), mode: state.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function rawGitHookPath(root: string): Promise<string> {
  const git = new GitClient(root);
  const [hookOutput, commonOutput] = await Promise.all([
    git.run(["rev-parse", "--git-path", "hooks/pre-commit"]),
    git.run(["rev-parse", "--git-common-dir"]),
  ]);
  const hook = isAbsolute(hookOutput.stdout)
    ? resolve(hookOutput.stdout)
    : resolve(root, hookOutput.stdout);
  const common = isAbsolute(commonOutput.stdout)
    ? resolve(commonOutput.stdout)
    : resolve(root, commonOutput.stdout);
  const canonicalCommon = await realpath(common);
  const hooksDirectory = resolve(canonicalCommon, "hooks");
  const hooksState = await lstat(hooksDirectory);
  if (hooksState.isSymbolicLink() || !hooksState.isDirectory()) {
    throw new Error("Zedbee refused an unsafe hook target.");
  }
  const canonicalHook = resolve(await realpath(dirname(hook)), basename(hook));
  if (canonicalHook !== resolve(hooksDirectory, "pre-commit")) {
    throw new Error("Zedbee refused an unsafe hook target.");
  }
  return canonicalHook;
}

async function exists(root: string, relativePath: string): Promise<boolean> {
  try {
    await lstat(join(root, relativePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function packageData(
  root: string,
): Promise<Record<string, unknown> | undefined> {
  const file = await existingFile(root, "package.json");
  if (file === undefined) return undefined;
  const parsed: unknown = JSON.parse(file.contents);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "Zedbee could not inspect package.json for hook integration.",
    );
  }
  return parsed as Record<string, unknown>;
}

function dependencyNames(
  manifest: Record<string, unknown> | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies"] as const) {
    const value = manifest?.[field];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      Object.keys(value).forEach((name) => names.add(name));
    }
  }
  return names;
}

async function autoChoice(root: string): Promise<ResolvedHookChoice> {
  const manifest = await packageData(root);
  const dependencies = dependencyNames(manifest);
  if ((await exists(root, ".husky/pre-commit")) || dependencies.has("husky")) {
    return "husky";
  }
  if (
    (await exists(root, "lefthook.yml")) ||
    (await exists(root, "lefthook.yaml")) ||
    dependencies.has("lefthook")
  ) {
    return "lefthook";
  }
  if (
    manifest?.["simple-git-hooks"] !== undefined ||
    dependencies.has("simple-git-hooks")
  ) {
    return "simple-git-hooks";
  }
  try {
    await rawGitHookPath(root);
    return "raw";
  } catch {
    return "none";
  }
}

async function changedFile(
  root: string,
  relativePath: string,
  update: (before: string | null) => string,
  defaultMode: number,
): Promise<InitFileChange> {
  const file = await existingFile(root, relativePath);
  const before = file?.contents ?? null;
  return initFileChange(
    relativePath,
    before,
    update(before),
    file?.mode ?? defaultMode,
  );
}

export async function detectHookIntegration(
  repositoryRoot: string,
  requested: InitHookChoice,
): Promise<DetectedHookIntegration> {
  const hook =
    requested === "auto" ? await autoChoice(repositoryRoot) : requested;
  if (hook === "none") {
    return Object.freeze({
      hook,
      activation: Object.freeze({
        status: "not-requested",
        message: "No pre-commit integration was requested.",
      }),
    });
  }
  if (hook === "husky") {
    return Object.freeze({
      hook,
      activation: ACTIVE_DIRECT(hook),
      change: await changedFile(
        repositoryRoot,
        ".husky/pre-commit",
        updateHuskyHook,
        0o755,
      ),
    });
  }
  if (hook === "lefthook") {
    const relativePath = (await exists(repositoryRoot, "lefthook.yaml"))
      ? "lefthook.yaml"
      : "lefthook.yml";
    return Object.freeze({
      hook,
      activation: await managerActivation(repositoryRoot, hook),
      change: await changedFile(
        repositoryRoot,
        relativePath,
        updateLefthookConfig,
        0o644,
      ),
    });
  }
  if (hook === "simple-git-hooks") {
    const file = await existingFile(repositoryRoot, "package.json");
    if (file === undefined) {
      throw new Error("simple-git-hooks integration requires package.json.");
    }
    return Object.freeze({
      hook,
      activation: await managerActivation(repositoryRoot, hook),
      change: initFileChange(
        "package.json",
        file.contents,
        updateSimpleGitHooksManifest(file.contents),
        file.mode,
      ),
    });
  }
  return Object.freeze({
    hook,
    activation: ACTIVE_DIRECT(hook),
    change: await (async () => {
      const absolutePath = await rawGitHookPath(repositoryRoot);
      const file = await existingAbsoluteFile(absolutePath);
      const before = file?.contents ?? null;
      return initFileChange(
        ".git/hooks/pre-commit",
        before,
        updateRawGitHook(before),
        file?.mode ?? 0o755,
        absolutePath,
      );
    })(),
  });
}
